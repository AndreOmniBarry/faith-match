"""End-to-end API behaviour: what a deployment with a database does, what
one without a database does, and who a submitted score gets filed under.

Both storage backends are exercised here too — the `store` fixture is
parametrised in conftest.py, so every test below runs on SQLite and (when
TEST_DATABASE_URL is set) on PostgreSQL.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import db
from app.main import app


@pytest.fixture
def client(store):
    """A client whose backend is the parametrised store."""
    db.reset_for_tests(store)
    with TestClient(app) as c:
        yield c
    db.reset_for_tests(None)


@pytest.fixture
def storageless_client():
    """A deployment with nowhere durable to write — a serverless host that
    hasn't been given a DATABASE_URL."""
    db.reset_for_tests(None)
    with TestClient(app) as c:
        yield c


def signup(client, username="Ruth", password="pass123") -> str:
    res = client.post("/api/account/register", json={"username": username, "password": password})
    assert res.status_code == 200, res.text
    return res.json()["token"]


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# Guest play works on every deployment, with or without a database
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("path", [
    "/api/health", "/api/modes", "/api/levels/grace-path/0",
    "/api/chapter/grace-path/1", "/api/daily",
])
def test_stateless_routes_work_without_a_database(storageless_client, path):
    assert storageless_client.get(path).status_code == 200


def test_health_reports_no_storage(storageless_client):
    storage = storageless_client.get("/api/health").json()["storage"]
    assert storage["backend"] == "none"
    assert storage["persistent"] is False


def test_health_reports_the_configured_backend(client, store):
    storage = client.get("/api/health").json()["storage"]
    assert storage["backend"] == store.name
    assert storage["persistent"] is True
    assert storage["reachable"] is True


def test_guest_score_is_validated_and_starred_without_a_database(storageless_client):
    res = storageless_client.post("/api/score", json={
        "mode": "grace-path", "levelIndex": 0, "score": 100000, "movesUsed": 20, "durationMs": 60000,
    })
    assert res.status_code == 200
    body = res.json()
    assert body["accepted"] is False  # the anti-cheat ceiling still applies
    assert body["recorded"] is False


def test_analytics_never_fails_a_client_without_a_database(storageless_client):
    res = storageless_client.post("/api/analytics/event", json={"event": "level_complete"})
    assert res.status_code == 200
    assert res.json() == {"ok": True}


@pytest.mark.parametrize("method,path", [
    ("post", "/api/account/register"), ("post", "/api/account/login"),
    ("get", "/api/account/state"), ("post", "/api/account/sync"),
    ("get", "/api/leaderboard/grace-path/0"),
])
def test_stateful_routes_say_501_rather_than_losing_data(storageless_client, method, path):
    payload = {"username": "Ruth", "password": "pass123", "state": {}}
    res = getattr(storageless_client, method)(path, **({"json": payload} if method == "post" else {}))
    assert res.status_code == 501
    assert "DATABASE_URL" in res.json()["detail"]


def test_logout_is_a_no_op_without_a_database(storageless_client):
    res = storageless_client.post("/api/account/logout", headers=auth("whatever"))
    assert res.status_code == 200
    assert res.json() == {"ok": True}


# ---------------------------------------------------------------------------
# Accounts and cloud saves, on a deployment that has a database
# ---------------------------------------------------------------------------

def test_register_login_and_sync_round_trip(client):
    save = {"gems": 40, "modes": {"grace-path": {"unlockedLevels": 12, "levelStars": {}}}}
    token = client.post("/api/account/register", json={
        "username": "Ruth", "password": "pass123", "state": save,
    }).json()["token"]

    assert client.get("/api/account/state", headers=auth(token)).json()["state"] == save

    moved_on = {"gems": 90, "modes": {"grace-path": {"unlockedLevels": 30, "levelStars": {}}}}
    assert client.post("/api/account/sync", json={"state": moved_on}, headers=auth(token)).status_code == 200

    # A second device signs in and finds the progress waiting for it.
    second = client.post("/api/account/login", json={"username": "ruth", "password": "pass123"})
    assert second.status_code == 200
    assert second.json()["state"] == moved_on
    assert second.json()["username"] == "Ruth"  # canonical spelling, not what was typed


def test_duplicate_signup_is_a_409(client):
    signup(client)
    res = client.post("/api/account/register", json={"username": "RUTH", "password": "other1"})
    assert res.status_code == 409


def test_wrong_password_is_a_401(client):
    signup(client)
    assert client.post("/api/account/login", json={"username": "Ruth", "password": "nope123"}).status_code == 401


def test_unknown_user_and_wrong_password_look_identical(client):
    signup(client)
    a = client.post("/api/account/login", json={"username": "Ruth", "password": "nope123"})
    b = client.post("/api/account/login", json={"username": "Nobody", "password": "nope123"})
    assert a.status_code == b.status_code == 401
    assert a.json()["detail"] == b.json()["detail"]


def test_bad_credentials_are_rejected_before_the_database(client):
    assert client.post("/api/account/register", json={"username": "a", "password": "pass123"}).status_code == 400
    assert client.post("/api/account/register", json={"username": "Ruth", "password": "short"}).status_code == 400


def test_state_requires_a_valid_token(client):
    assert client.get("/api/account/state").status_code == 401
    assert client.get("/api/account/state", headers=auth("forged")).status_code == 401


def test_logout_invalidates_the_token(client):
    token = signup(client)
    assert client.post("/api/account/logout", headers=auth(token)).status_code == 200
    assert client.get("/api/account/state", headers=auth(token)).status_code == 401


# ---------------------------------------------------------------------------
# Score attribution — the "Anonymous" fix, end to end
# ---------------------------------------------------------------------------

GOOD_RUN = {"mode": "grace-path", "levelIndex": 0, "score": 1200, "movesUsed": 18, "durationMs": 45000}


def test_a_signed_in_run_lands_on_the_board_under_the_players_name(client):
    token = signup(client, "Ruth")
    body = client.post("/api/score", json=GOOD_RUN, headers=auth(token)).json()
    assert body["accepted"] is True
    assert body["recorded"] is True
    assert body["player"] == "Ruth"

    entries = client.get("/api/leaderboard/grace-path/0").json()["entries"]
    assert [e["player"] for e in entries] == ["Ruth"]


def test_no_score_is_ever_stored_as_anonymous(client):
    token = signup(client, "Ruth")
    client.post("/api/score", json=GOOD_RUN, headers=auth(token))
    client.post("/api/score", json=GOOD_RUN)  # a guest run alongside it
    players = {e["player"] for e in client.get("/api/leaderboard/grace-path/0").json()["entries"]}
    assert players == {"Ruth"}


def test_a_guest_run_is_starred_but_not_ranked(client):
    body = client.post("/api/score", json=GOOD_RUN).json()
    assert body["accepted"] is True
    assert body["stars"] >= 0
    assert body["recorded"] is False
    assert client.get("/api/leaderboard/grace-path/0").json()["entries"] == []


def test_a_name_in_the_request_body_is_ignored(client):
    """An older client (or a crafted request) can still put a `player`
    field on the wire. It must have no effect: identity comes from the
    token, so a run posted as "Impostor" with Ruth's token is Ruth's, and
    one posted as "Impostor" with no token reaches no board at all."""
    token = signup(client, "Ruth")
    client.post("/api/score", json={**GOOD_RUN, "player": "Impostor"}, headers=auth(token))
    client.post("/api/score", json={**GOOD_RUN, "levelIndex": 1, "player": "Impostor"})

    assert [e["player"] for e in client.get("/api/leaderboard/grace-path/0").json()["entries"]] == ["Ruth"]
    assert client.get("/api/leaderboard/grace-path/1").json()["entries"] == []


def test_an_expired_token_falls_back_to_guest_rather_than_erroring(client):
    """A session that lapses mid-session must not turn a finished level
    into an error dialog."""
    res = client.post("/api/score", json=GOOD_RUN, headers=auth("long-expired"))
    assert res.status_code == 200
    assert res.json()["recorded"] is False


def test_a_cheating_score_is_rejected_and_never_stored(client):
    token = signup(client, "Ruth")
    body = client.post("/api/score", headers=auth(token), json={
        "mode": "grace-path", "levelIndex": 0, "score": 999999, "movesUsed": 3, "durationMs": 500,
    }).json()
    assert body["accepted"] is False
    assert body["recorded"] is False
    assert client.get("/api/leaderboard/grace-path/0").json()["entries"] == []


def test_the_board_shows_the_signed_in_player_their_own_rank(client):
    ruth = signup(client, "Ruth")
    boaz = signup(client, "Boaz")
    client.post("/api/score", json={**GOOD_RUN, "score": 900}, headers=auth(ruth))
    client.post("/api/score", json={**GOOD_RUN, "score": 1400}, headers=auth(boaz))

    board = client.get("/api/leaderboard/grace-path/0", headers=auth(ruth)).json()
    assert [e["player"] for e in board["entries"]] == ["Boaz", "Ruth"]
    assert board["you"]["player"] == "Ruth"
    assert board["you"]["rank"] == 2

    assert client.get("/api/leaderboard/grace-path/0").json()["you"] is None


def test_replaying_a_level_keeps_the_best_run_not_the_last(client):
    token = signup(client, "Ruth")
    client.post("/api/score", json={**GOOD_RUN, "score": 1400}, headers=auth(token))
    client.post("/api/score", json={**GOOD_RUN, "score": 300}, headers=auth(token))
    entries = client.get("/api/leaderboard/grace-path/0").json()["entries"]
    assert len(entries) == 1
    assert entries[0]["score"] == 1400


def test_unknown_mode_is_a_404(client):
    assert client.post("/api/score", json={**GOOD_RUN, "mode": "nope"}).status_code == 404
    assert client.get("/api/leaderboard/nope/0").status_code == 404
