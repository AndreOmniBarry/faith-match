"""SQLite backend — local development, and any single-process host with
real disk (a VPS running uvicorn, the on-device case if the SDK ever wants
it). Stdlib `sqlite3` only, so `pip install fastapi && uvicorn app.main:app`
still gets you a working backend with no database to provision.

Not production for this launch: a serverless deployment has no durable,
shared filesystem, so every instance would get its own empty file. That's
what postgres_store.py is for.
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path

from .base import Store

SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at REAL NOT NULL
    )
    """,
    # Case-insensitive uniqueness as an expression index rather than
    # COLLATE NOCASE on the column, so it matches the `lower(username) =
    # lower(?)` lookup in base.py that PostgreSQL also uses. Players won't
    # remember whether they signed up as "Alice" or "alice".
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_players_username ON players (lower(username))",
    """
    CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        created_at REAL NOT NULL,
        expires_at REAL NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_sessions_player ON sessions(player_id)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at)",
    # One row per player: the whole client-side save blob (see js/state.js's
    # STORAGE_KEY shape), stored opaquely as JSON. The server doesn't need to
    # understand its contents, just persist and hand it back — last-write-wins,
    # timestamped by the client.
    """
    CREATE TABLE IF NOT EXISTS player_state (
        player_id INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
        state_json TEXT NOT NULL,
        updated_at REAL NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS leaderboard (
        mode TEXT NOT NULL,
        level_index INTEGER NOT NULL,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        player TEXT NOT NULL,
        score INTEGER NOT NULL,
        stars INTEGER NOT NULL,
        created_at REAL NOT NULL,
        PRIMARY KEY (mode, level_index, player_id)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_leaderboard_top ON leaderboard(mode, level_index, score DESC)",
    """
    CREATE TABLE IF NOT EXISTS analytics_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,
        payload TEXT,
        created_at REAL NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics_events(created_at)",
]


class SqliteStore(Store):
    name = "sqlite"

    def __init__(self, path: Path | str):
        self.path = Path(path)

    @contextmanager
    def _connect(self):
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        # Foreign keys are off by default in SQLite; the ON DELETE CASCADEs
        # above are decoration without this.
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _schema_statements(self) -> list[str]:
        return SCHEMA

    def _insert_returning_id(self, cur, sql: str, params: tuple) -> int:
        cur.execute(sql, params)
        return int(cur.lastrowid)

    def _is_unique_violation(self, exc: BaseException) -> bool:
        return isinstance(exc, sqlite3.IntegrityError) and "UNIQUE" in str(exc).upper()

    def init_schema(self) -> None:
        self._migrate_legacy_leaderboard()
        super().init_schema()

    def _migrate_legacy_leaderboard(self) -> None:
        """The first version of this table logged one row per *attempt*,
        keyed by an autoincrement id, with the player as a free-text name
        off the request body and no player_id at all (which is exactly how
        every score ended up filed under "Anonymous"). There is no
        production data to preserve — those routes only ever answered 501
        on the deployed build — so a stale local dev file is rebuilt rather
        than migrated row by row.
        """
        with self._connect() as conn:
            exists = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='leaderboard'"
            ).fetchone()
            if not exists:
                return
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(leaderboard)")}
            if "player_id" in columns:
                return
            conn.execute("DROP INDEX IF EXISTS idx_leaderboard_level")
            conn.execute("DROP TABLE leaderboard")
