"""Storage behaviour, checked identically on SQLite and PostgreSQL.

These are the guarantees the game leans on: an account survives a restart,
a cloud save round-trips byte-for-byte, and a leaderboard row belongs to
the player who earned it.
"""

from __future__ import annotations

import json
import time

import pytest

from app.storage import UsernameTaken


def _player(store, username="Ruth", password_hash="hash"):
    return store.create_player(username, password_hash)


# ---------------------------------------------------------------------------
# Accounts
# ---------------------------------------------------------------------------

def test_player_round_trips(store):
    player_id = _player(store)
    found = store.get_player_by_username("Ruth")
    assert found is not None
    assert found["id"] == player_id
    assert found["password_hash"] == "hash"


def test_username_lookup_is_case_insensitive(store):
    player_id = _player(store, "Ruth")
    for spelling in ("ruth", "RUTH", "RuTh"):
        assert store.get_player_by_username(spelling)["id"] == player_id


def test_duplicate_username_is_rejected_regardless_of_case(store):
    _player(store, "Ruth")
    with pytest.raises(UsernameTaken):
        store.create_player("ruth", "other-hash")


def test_unknown_username_is_none_not_an_error(store):
    assert store.get_player_by_username("nobody") is None
    assert store.get_player_by_username("") is None


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

def test_session_resolves_to_its_player(store):
    player_id = _player(store)
    store.create_session(player_id, "tok", time.time() + 60)
    assert store.get_player_by_token("tok")["id"] == player_id


def test_expired_session_is_indistinguishable_from_a_bogus_one(store):
    player_id = _player(store)
    store.create_session(player_id, "stale", time.time() - 1)
    assert store.get_player_by_token("stale") is None
    assert store.get_player_by_token("never-issued") is None


def test_refresh_extends_a_session(store):
    player_id = _player(store)
    store.create_session(player_id, "tok", time.time() - 1)
    assert store.get_player_by_token("tok") is None
    store.refresh_session("tok", time.time() + 60)
    assert store.get_player_by_token("tok")["id"] == player_id


def test_logout_deletes_the_session(store):
    player_id = _player(store)
    store.create_session(player_id, "tok", time.time() + 60)
    store.delete_session("tok")
    assert store.get_player_by_token("tok") is None


def test_purge_removes_only_expired_sessions(store):
    player_id = _player(store)
    store.create_session(player_id, "live", time.time() + 600)
    store.create_session(player_id, "dead", time.time() - 600)
    store.purge_expired_sessions()
    assert store.get_player_by_token("live") is not None
    assert store.get_player_by_token("dead") is None


# ---------------------------------------------------------------------------
# Cloud save
# ---------------------------------------------------------------------------

def test_cloud_save_round_trips_unchanged(store):
    player_id = _player(store)
    save = {
        "soundOn": True,
        "modes": {"grace-path": {"unlockedLevels": 42, "levelStars": {"0": 3, "1": 2}}},
        "lives": 5, "livesUpdatedAt": 1710000000000, "gems": 120,
        "inventory": {"extraMoves": 2},
        "daily": {"lastCompletedDate": "2026-09-17", "streak": 9, "session": None},
    }
    store.save_player_state(player_id, json.dumps(save), 1710000000.5)

    row = store.load_player_state(player_id)
    assert json.loads(row["state_json"]) == save
    assert row["updated_at"] == pytest.approx(1710000000.5)


def test_cloud_save_is_last_write_wins(store):
    player_id = _player(store)
    store.save_player_state(player_id, json.dumps({"gems": 1}), 1.0)
    store.save_player_state(player_id, json.dumps({"gems": 2}), 2.0)
    row = store.load_player_state(player_id)
    assert json.loads(row["state_json"]) == {"gems": 2}
    assert row["updated_at"] == pytest.approx(2.0)


def test_no_cloud_save_yet_is_none(store):
    assert store.load_player_state(_player(store)) is None


# ---------------------------------------------------------------------------
# Leaderboard — the "Anonymous" fix
# ---------------------------------------------------------------------------

def test_score_is_stored_under_the_players_name(store):
    player_id = _player(store, "Ruth")
    store.record_score("grace-path", 3, player_id, "Ruth", 5000, 3)
    entries = store.top_scores("grace-path", 3)
    assert [e["player"] for e in entries] == ["Ruth"]
    assert entries[0]["score"] == 5000
    assert "Anonymous" not in {e["player"] for e in entries}


def test_a_player_holds_one_row_per_level_not_one_per_attempt(store):
    player_id = _player(store, "Ruth")
    for score in (1000, 4000, 2500):
        store.record_score("grace-path", 3, player_id, "Ruth", score, 2)
    entries = store.top_scores("grace-path", 3)
    assert len(entries) == 1
    assert entries[0]["score"] == 4000  # their best, not their latest


def test_a_worse_run_never_demotes_a_better_one(store):
    player_id = _player(store, "Ruth")
    assert store.record_score("grace-path", 0, player_id, "Ruth", 9000, 3) is True
    assert store.record_score("grace-path", 0, player_id, "Ruth", 100, 1) is False
    best = store.player_best("grace-path", 0, player_id)
    assert best["score"] == 9000
    assert best["stars"] == 3


def test_boards_are_per_level_and_per_mode(store):
    player_id = _player(store, "Ruth")
    store.record_score("grace-path", 0, player_id, "Ruth", 100, 1)
    store.record_score("grace-path", 1, player_id, "Ruth", 200, 2)
    store.record_score("harvest", 0, player_id, "Ruth", 300, 3)
    assert [e["score"] for e in store.top_scores("grace-path", 0)] == [100]
    assert [e["score"] for e in store.top_scores("grace-path", 1)] == [200]
    assert [e["score"] for e in store.top_scores("harvest", 0)] == [300]
    assert store.top_scores("refiners-fire", 0) == []


def test_top_scores_are_ranked_and_limited(store):
    for name, score in [("Ruth", 300), ("Boaz", 500), ("Naomi", 100), ("Esther", 400)]:
        store.record_score("grace-path", 0, _player(store, name), name, score, 2)
    top = store.top_scores("grace-path", 0, limit=3)
    assert [e["player"] for e in top] == ["Boaz", "Esther", "Ruth"]


def test_rank_counts_the_players_ahead(store):
    for name, score in [("Boaz", 500), ("Esther", 400), ("Ruth", 300)]:
        store.record_score("grace-path", 0, _player(store, name), name, score, 2)
    assert store.player_rank("grace-path", 0, 500) == 1
    assert store.player_rank("grace-path", 0, 400) == 2
    assert store.player_rank("grace-path", 0, 250) == 4
    assert store.player_rank("grace-path", 0, 999) == 1


def test_player_best_is_none_before_they_rank(store):
    assert store.player_best("grace-path", 0, _player(store)) is None


def test_display_name_follows_the_account(store):
    """The board denormalises the name for read speed; a later score must
    refresh it rather than leave a stale copy on the row."""
    player_id = _player(store, "Ruth")
    store.record_score("grace-path", 0, player_id, "Ruth", 100, 1)
    store.record_score("grace-path", 0, player_id, "Ruth_v2", 200, 2)
    assert store.top_scores("grace-path", 0)[0]["player"] == "Ruth_v2"


# ---------------------------------------------------------------------------
# Analytics + health
# ---------------------------------------------------------------------------

def test_events_are_recorded(store):
    store.record_event("level_complete", json.dumps({"mode": "grace-path", "index": 4}))
    store.record_event("level_failed", None)
    rows = store._all("SELECT event, payload FROM analytics_events ORDER BY id")
    assert [r["event"] for r in rows] == ["level_complete", "level_failed"]
    assert json.loads(rows[0]["payload"])["index"] == 4
    assert rows[1]["payload"] is None


def test_ping_reports_reachable(store):
    assert store.ping() is True


def test_init_schema_is_idempotent(store):
    player_id = _player(store)
    store.init_schema()
    store.init_schema()
    assert store.get_player_by_username("Ruth")["id"] == player_id
