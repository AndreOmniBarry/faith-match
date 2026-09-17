"""Backend-agnostic storage for accounts, cloud saves, leaderboards and
analytics.

Every query the app runs lives here, exactly once, written in the SQL
subset both SQLite and PostgreSQL speak (`ON CONFLICT ... DO UPDATE`,
`lower(col) = lower(?)`, plain `?` placeholders). Subclasses supply only
the three things that genuinely differ between the two engines: how to
get a connection, the CREATE TABLE dialect, and how an INSERT hands back
its new primary key. That's the whole reason this file exists — so
"which database is Faith Match on today" is a deployment decision, not a
rewrite.

See sqlite_store.py (local dev, single process, real disk) and
postgres_store.py (anything serverless or multi-instance, which is what
production actually is).
"""

from __future__ import annotations

import json
import time
from abc import ABC, abstractmethod
from contextlib import contextmanager

# Session tokens are opaque random strings; 90 days, refreshed on use.
# (Kept alongside the schema rather than in auth.py because the sessions
# table is what actually enforces it.)


class StorageError(RuntimeError):
    """The store is configured but momentarily unreachable — a dropped
    connection, a database restart, a pool timeout. Routes turn this into
    a 503 (try again), never a 500, because nothing is actually broken."""


class StorageConfigurationError(StorageError):
    """The store can never work as configured: a driver that isn't
    installed, a malformed connection string. Also a 503 — the service
    genuinely can't serve these routes — but told apart from the transient
    case because the answer is different. "Try again in a moment" is
    actively wrong advice for a deployment that needs a person to change
    something; no amount of retrying installs a driver."""


class UsernameTaken(Exception):
    """Raised by create_player() instead of leaking a driver-specific
    integrity error up into account.py — the caller wants "409", not
    "psycopg.errors.UniqueViolation"."""


class Store(ABC):
    """One database, whichever engine is behind it."""

    #: Human-readable backend name, for /api/health and logs.
    name: str = "unknown"

    #: True when this store keeps data across process restarts and across
    #: separate serverless invocations. Everything in this repo is durable;
    #: the flag exists so a future in-memory test double can say otherwise.
    durable: bool = True

    # ------------------------------------------------------------------
    # Engine-specific hooks — the only three things subclasses implement.
    # ------------------------------------------------------------------

    @abstractmethod
    @contextmanager
    def _connect(self):
        """Yields a DB-API connection whose cursors return dict-like rows.
        Commits on clean exit, rolls back on exception."""

    @abstractmethod
    def _schema_statements(self) -> list[str]:
        """The engine's CREATE TABLE / CREATE INDEX statements, each
        idempotent (IF NOT EXISTS) so init_schema() is safe to re-run on
        every cold start."""

    @abstractmethod
    def _insert_returning_id(self, cur, sql: str, params: tuple) -> int:
        """Run an INSERT and return the new row's id. SQLite reads
        cur.lastrowid; PostgreSQL needs an explicit RETURNING clause."""

    def _is_unique_violation(self, exc: BaseException) -> bool:
        """True if `exc` is this engine's "unique constraint failed"."""
        return False

    def _adapt(self, sql: str) -> str:
        """Placeholder style. SQLite takes `?` as written; psycopg wants
        `%s` (overridden there)."""
        return sql

    # ------------------------------------------------------------------
    # Query plumbing
    # ------------------------------------------------------------------

    @contextmanager
    def _cursor(self):
        with self._connect() as conn:
            cur = conn.cursor()
            try:
                yield cur
            finally:
                cur.close()

    def _exec(self, sql: str, params: tuple = ()) -> None:
        with self._cursor() as cur:
            cur.execute(self._adapt(sql), params)

    def _one(self, sql: str, params: tuple = ()) -> dict | None:
        with self._cursor() as cur:
            cur.execute(self._adapt(sql), params)
            row = cur.fetchone()
        return dict(row) if row is not None else None

    def _all(self, sql: str, params: tuple = ()) -> list[dict]:
        with self._cursor() as cur:
            cur.execute(self._adapt(sql), params)
            rows = cur.fetchall()
        return [dict(r) for r in rows]

    # ------------------------------------------------------------------
    # Schema
    # ------------------------------------------------------------------

    def init_schema(self) -> None:
        with self._cursor() as cur:
            for statement in self._schema_statements():
                cur.execute(statement)

    def ping(self) -> bool:
        """Cheap reachability check for /api/health. Never raises — a
        health endpoint that 500s tells a load balancer less than one
        that reports `false`."""
        try:
            self._one("SELECT 1 AS ok")
            return True
        except Exception:
            return False

    # ------------------------------------------------------------------
    # Players / sessions
    # ------------------------------------------------------------------

    def create_player(self, username: str, password_hash: str) -> int:
        sql = "INSERT INTO players (username, password_hash, created_at) VALUES (?,?,?)"
        try:
            with self._cursor() as cur:
                return self._insert_returning_id(
                    cur, self._adapt(sql), (username, password_hash, time.time())
                )
        except Exception as exc:
            if self._is_unique_violation(exc):
                raise UsernameTaken(username) from exc
            raise

    def get_player_by_username(self, username: str) -> dict | None:
        # lower(...) on both sides rather than SQLite's COLLATE NOCASE, so
        # one query works on both engines. Each backend carries a matching
        # unique index on lower(username) so this stays index-backed and
        # "Alice" can never coexist with "alice".
        return self._one("SELECT * FROM players WHERE lower(username) = lower(?)", (username,))

    def create_session(self, player_id: int, token: str, expires_at: float) -> None:
        self._exec(
            "INSERT INTO sessions (token, player_id, created_at, expires_at) VALUES (?,?,?,?)",
            (token, player_id, time.time(), expires_at),
        )

    def get_player_by_token(self, token: str) -> dict | None:
        """None if the token doesn't exist *or* has expired — callers can't
        tell the difference, which is the point (an expired token should
        look exactly like an invalid one to the client)."""
        return self._one(
            "SELECT players.* FROM sessions JOIN players ON players.id = sessions.player_id "
            "WHERE sessions.token = ? AND sessions.expires_at > ?",
            (token, time.time()),
        )

    def refresh_session(self, token: str, expires_at: float) -> None:
        self._exec("UPDATE sessions SET expires_at = ? WHERE token = ?", (expires_at, token))

    def delete_session(self, token: str) -> None:
        self._exec("DELETE FROM sessions WHERE token = ?", (token,))

    def purge_expired_sessions(self, now: float | None = None) -> int:
        """Housekeeping. Sessions refresh on every use, so rows only go
        stale when a player stops playing for 90 days — but at launch
        scale that is still a table that grows forever if nothing sweeps
        it. Called opportunistically at login, not on a timer."""
        with self._cursor() as cur:
            cur.execute(self._adapt("DELETE FROM sessions WHERE expires_at < ?"), (now or time.time(),))
            return cur.rowcount if cur.rowcount is not None and cur.rowcount > 0 else 0

    # ------------------------------------------------------------------
    # Cloud save
    # ------------------------------------------------------------------

    def save_player_state(self, player_id: int, state_json: str, updated_at: float) -> None:
        self._exec(
            "INSERT INTO player_state (player_id, state_json, updated_at) VALUES (?,?,?) "
            "ON CONFLICT (player_id) DO UPDATE SET state_json = excluded.state_json, "
            "updated_at = excluded.updated_at",
            (player_id, state_json, updated_at),
        )

    def load_player_state(self, player_id: int) -> dict | None:
        return self._one(
            "SELECT state_json, updated_at FROM player_state WHERE player_id = ?", (player_id,)
        )

    # ------------------------------------------------------------------
    # Leaderboard
    # ------------------------------------------------------------------

    def record_score(self, mode: str, level_index: int, player_id: int, player: str,
                     score: int, stars: int) -> bool:
        """One row per (mode, level, player), holding that player's best —
        not one row per attempt. A billion players grinding a level would
        otherwise write a billion rows apiece for a top-10 board that only
        ever reads the best of each.

        Returns True if this run actually improved the player's record.
        The `WHERE ... < excluded.score` guard makes the upsert a no-op for
        a worse run, so a bad attempt can never demote a good one.

        `player` is the display name denormalised at scoring time so the
        board renders without a join; it comes from the authenticated
        session (see main.py), never from the request body.
        """
        with self._cursor() as cur:
            cur.execute(
                self._adapt(
                    "INSERT INTO leaderboard (mode, level_index, player_id, player, score, stars, created_at) "
                    "VALUES (?,?,?,?,?,?,?) "
                    "ON CONFLICT (mode, level_index, player_id) DO UPDATE SET "
                    "score = excluded.score, stars = excluded.stars, "
                    "player = excluded.player, created_at = excluded.created_at "
                    "WHERE leaderboard.score < excluded.score"
                ),
                (mode, level_index, player_id, player[:40], score, stars, time.time()),
            )
            return bool(cur.rowcount)

    def top_scores(self, mode: str, level_index: int, limit: int = 10) -> list[dict]:
        return self._all(
            "SELECT player, score, stars, created_at FROM leaderboard "
            "WHERE mode = ? AND level_index = ? ORDER BY score DESC, created_at ASC LIMIT ?",
            (mode, level_index, limit),
        )

    def player_best(self, mode: str, level_index: int, player_id: int) -> dict | None:
        """The signed-in player's own entry, so the board can show "you"
        even when they're nowhere near the top ten."""
        return self._one(
            "SELECT player, score, stars, created_at FROM leaderboard "
            "WHERE mode = ? AND level_index = ? AND player_id = ?",
            (mode, level_index, player_id),
        )

    def player_rank(self, mode: str, level_index: int, score: int) -> int:
        """1-based rank a given score would hold on this level's board."""
        row = self._one(
            "SELECT COUNT(*) AS ahead FROM leaderboard "
            "WHERE mode = ? AND level_index = ? AND score > ?",
            (mode, level_index, score),
        )
        return int(row["ahead"]) + 1 if row else 1

    # ------------------------------------------------------------------
    # Analytics
    # ------------------------------------------------------------------

    def record_event(self, event: str, payload: str | None) -> None:
        self._exec(
            "INSERT INTO analytics_events (event, payload, created_at) VALUES (?,?,?)",
            (event[:80], payload, time.time()),
        )


def json_dumps(value) -> str:
    """Compact, stable JSON for anything stored in a TEXT column."""
    return json.dumps(value, separators=(",", ":"), sort_keys=True)
