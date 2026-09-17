"""How the service behaves when its database is configured but unusable.

These are the deployment accidents that matter most, because they happen
to a live game rather than to a developer: a `DATABASE_URL` pointing at a
host that isn't answering, or a build where the PostgreSQL driver didn't
install. Neither may take the service down, and neither may tell a player
something that isn't true.
"""

from __future__ import annotations

import builtins
import sys

import pytest
from fastapi.testclient import TestClient

from app import db
from app.storage import PostgresStore, StorageConfigurationError, StorageError


@pytest.fixture
def without_psycopg(monkeypatch):
    """Make `import psycopg` fail, the way a build that didn't install it
    would."""
    real_import = builtins.__import__

    def blocked(name, *args, **kwargs):
        if name.split(".")[0] in {"psycopg", "psycopg_pool"}:
            raise ImportError(f"No module named {name!r}")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", blocked)
    for module in [m for m in sys.modules if m.split(".")[0] in {"psycopg", "psycopg_pool"}]:
        monkeypatch.delitem(sys.modules, module, raising=False)


@pytest.fixture
def unreachable_client(request):
    """A deployment whose database is configured but not answering."""
    # Sub-second timeouts: this test asserts on the *shape* of the failure,
    # and waiting out a realistic one would pad the suite by half a minute.
    store = PostgresStore(
        getattr(request, "param", "postgresql://user:pass@127.0.0.1:1/nope"),
        pool_timeout=0.5, connect_timeout=0.5,
    )
    db.reset_for_tests(store)
    with TestClient(app_module().app) as c:
        yield c
    db.reset_for_tests(None)


def app_module():
    from app import main
    return main


# ---------------------------------------------------------------------------
# A missing driver
# ---------------------------------------------------------------------------

def test_a_missing_driver_is_a_configuration_error(without_psycopg):
    store = PostgresStore("postgresql://user:pass@example.invalid/db")
    with pytest.raises(StorageConfigurationError):
        store.ping() or store.get_player_by_username("anyone")


def test_the_app_still_imports_and_serves_without_the_driver(without_psycopg):
    """The import is lazy for exactly this reason: a driver that didn't
    install must cost the game its leaderboards, not its levels."""
    db.reset_for_tests(PostgresStore("postgresql://user:pass@example.invalid/db"))
    try:
        with TestClient(app_module().app) as c:
            assert c.get("/api/levels/grace-path/12").status_code == 200
            assert c.get("/api/daily").status_code == 200
            assert c.get("/api/chapter/grace-path/1").status_code == 200
    finally:
        db.reset_for_tests(None)


def test_guest_play_is_unaffected_by_a_missing_driver(without_psycopg):
    db.reset_for_tests(PostgresStore("postgresql://user:pass@example.invalid/db"))
    try:
        with TestClient(app_module().app) as c:
            body = c.post("/api/score", json={
                "mode": "grace-path", "levelIndex": 0, "score": 1200,
                "movesUsed": 18, "durationMs": 45000,
            }).json()
            assert body["accepted"] is True
            assert body["recorded"] is False
    finally:
        db.reset_for_tests(None)


def test_a_missing_driver_does_not_tell_the_player_to_retry(without_psycopg):
    """A permanent misconfiguration answering "try again in a moment" sends
    a player into a loop and hides the problem from whoever runs the
    deployment. It must say what is actually true instead."""
    db.reset_for_tests(PostgresStore("postgresql://user:pass@example.invalid/db"))
    try:
        with TestClient(app_module().app) as c:
            res = c.post("/api/account/register", json={"username": "Ruth", "password": "pass123"})
            assert res.status_code == 503
            detail = res.json()["detail"]
            assert "try again" not in detail.lower()
            assert "isn't set up correctly" in detail
            assert "still saved on this device" in detail
    finally:
        db.reset_for_tests(None)


def test_analytics_is_still_silent_when_the_driver_is_missing(without_psycopg):
    db.reset_for_tests(PostgresStore("postgresql://user:pass@example.invalid/db"))
    try:
        with TestClient(app_module().app) as c:
            res = c.post("/api/analytics/event", json={"event": "level_complete"})
            assert res.status_code == 200
            assert res.json() == {"ok": True}
    finally:
        db.reset_for_tests(None)


def test_health_reports_a_configured_but_unreachable_backend(without_psycopg):
    db.reset_for_tests(PostgresStore("postgresql://user:pass@example.invalid/db"))
    try:
        with TestClient(app_module().app) as c:
            storage = c.get("/api/health").json()["storage"]
            assert storage["backend"] == "postgres"
            assert storage["reachable"] is False
    finally:
        db.reset_for_tests(None)


# ---------------------------------------------------------------------------
# A database that is simply down
# ---------------------------------------------------------------------------

def test_an_unreachable_database_is_a_transient_error(unreachable_client):
    """This one really does clear on a retry, so saying so is correct."""
    res = unreachable_client.post("/api/account/login", json={"username": "Ruth", "password": "pass123"})
    assert res.status_code == 503
    assert "try again" in res.json()["detail"].lower()


def test_levels_still_serve_while_the_database_is_down(unreachable_client):
    assert unreachable_client.get("/api/levels/grace-path/40").status_code == 200
    assert unreachable_client.get("/api/daily").status_code == 200


def test_a_transient_error_is_not_a_configuration_error():
    assert issubclass(StorageConfigurationError, StorageError)
    assert not isinstance(StorageError("down"), StorageConfigurationError)
