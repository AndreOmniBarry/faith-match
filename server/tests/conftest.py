"""Both storage backends, driven through the same tests.

Every test in test_storage.py runs twice: once against a throwaway SQLite
file and once against PostgreSQL, so "works locally, breaks in production"
can't happen quietly — the two engines disagree about enough (placeholder
style, RETURNING, case-insensitive uniqueness, upsert semantics) that a
single-backend test suite would prove very little about the deployment
that actually matters.

The PostgreSQL round is skipped, loudly, when there's no database to point
at. Set TEST_DATABASE_URL to run it:

    TEST_DATABASE_URL=postgresql://user:pass@localhost/faithmatch_test pytest

It creates and drops its own tables, so give it a scratch database, never
a real one.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.storage import PostgresStore, SqliteStore  # noqa: E402

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "").strip()

ALL_TABLES = ["leaderboard", "player_state", "sessions", "analytics_events", "players"]


def _fresh_postgres() -> PostgresStore:
    store = PostgresStore(TEST_DATABASE_URL)
    with store._cursor() as cur:
        # Order matters: leaderboard/player_state/sessions all reference
        # players. CASCADE would do it too, but naming them keeps the blast
        # radius of a mis-pointed TEST_DATABASE_URL to this app's tables.
        for table in ALL_TABLES:
            cur.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
    store.init_schema()
    return store


@pytest.fixture(params=["sqlite", "postgres"])
def store(request, tmp_path):
    if request.param == "sqlite":
        s = SqliteStore(tmp_path / "test.db")
        s.init_schema()
        yield s
        return

    if not TEST_DATABASE_URL:
        pytest.skip("set TEST_DATABASE_URL to run the PostgreSQL round of these tests")
    s = _fresh_postgres()
    try:
        yield s
    finally:
        s.close()
