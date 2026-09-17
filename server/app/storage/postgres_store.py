"""PostgreSQL backend — what production runs on.

Chosen over "some hosted SQLite" or a key-value store for one reason that
matters at launch scale: Postgres is the one interface every serious host
speaks, so the hosting decision stays reversible. The same code and the
same `DATABASE_URL` run against Neon, Supabase, Vercel Postgres, Cloud SQL
or a self-managed cluster; moving between them is a connection string, not
a rewrite.

Serverless notes, because they're the whole difficulty here:

* Connections are pooled with `min_size=0`. A cold function that only
  serves level generation (which touches no database at all) must not pay
  for, or hold open, a Postgres connection it never uses.
* `max_size` is deliberately small. Serverless scales out by running many
  instances, so per-instance pools multiply; the ceiling that matters is
  the database's, not this process's. Point `DATABASE_URL` at the host's
  *pooled* endpoint (pgbouncer — Neon and Supabase both publish one) and
  this stays comfortable no matter how many instances are live.
* The pool is created lazily and reused across invocations of a warm
  instance, so the usual case is a connection checkout, not a TCP+TLS
  handshake.
"""

from __future__ import annotations

import os
import threading
from contextlib import contextmanager

from .base import Store, StorageConfigurationError, StorageError

# psycopg 3. Imported lazily in _pool() rather than at module import, so a
# deployment that runs on SQLite (local dev) doesn't need the driver
# installed at all, and an import error surfaces as a clear 503 on the
# routes that need a database instead of taking the whole app down at
# startup — level generation and the daily challenge keep working.

DEFAULT_MAX_CONNECTIONS = 4
# Fail fast, deliberately. js/account.js gives up on an account request
# after 8s, so a server that spends longer than that dialling a dead
# database is billing serverless time to produce an answer nobody is still
# listening for. Five seconds is comfortably longer than a healthy connect
# (single-digit milliseconds warm, a few hundred through a pooler on a cold
# database) and comfortably shorter than the client's patience.
DEFAULT_CONNECT_TIMEOUT = 5  # seconds to establish a new connection
DEFAULT_POOL_TIMEOUT = 5     # seconds to wait for a free connection

SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS players (
        id BIGSERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at DOUBLE PRECISION NOT NULL
    )
    """,
    # Matches the `lower(username) = lower(?)` lookup in base.py, and makes
    # "Alice" and "alice" the same account.
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_players_username ON players (lower(username))",
    """
    CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        created_at DOUBLE PRECISION NOT NULL,
        expires_at DOUBLE PRECISION NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_sessions_player ON sessions(player_id)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at)",
    """
    CREATE TABLE IF NOT EXISTS player_state (
        player_id BIGINT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
        state_json TEXT NOT NULL,
        updated_at DOUBLE PRECISION NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS leaderboard (
        mode TEXT NOT NULL,
        level_index INTEGER NOT NULL,
        player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        player TEXT NOT NULL,
        score INTEGER NOT NULL,
        stars INTEGER NOT NULL,
        created_at DOUBLE PRECISION NOT NULL,
        PRIMARY KEY (mode, level_index, player_id)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_leaderboard_top ON leaderboard(mode, level_index, score DESC)",
    """
    CREATE TABLE IF NOT EXISTS analytics_events (
        id BIGSERIAL PRIMARY KEY,
        event TEXT NOT NULL,
        payload TEXT,
        created_at DOUBLE PRECISION NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics_events(created_at)",
]


class PostgresStore(Store):
    name = "postgres"

    def __init__(self, dsn: str, max_connections: int | None = None,
                 pool_timeout: float | None = None, connect_timeout: float | None = None):
        self.dsn = dsn
        self.max_connections = max_connections or int(
            os.environ.get("FAITHMATCH_DB_MAX_CONNECTIONS", DEFAULT_MAX_CONNECTIONS)
        )
        self.pool_timeout = pool_timeout if pool_timeout is not None else float(
            os.environ.get("FAITHMATCH_DB_POOL_TIMEOUT", DEFAULT_POOL_TIMEOUT)
        )
        self.connect_timeout = connect_timeout if connect_timeout is not None else float(
            os.environ.get("FAITHMATCH_DB_CONNECT_TIMEOUT", DEFAULT_CONNECT_TIMEOUT)
        )
        self._pool = None
        self._pool_lock = threading.Lock()

    # ------------------------------------------------------------------

    def _make_pool(self):
        try:
            from psycopg.rows import dict_row
            from psycopg_pool import ConnectionPool
        except ImportError as exc:
            raise StorageConfigurationError(
                "DATABASE_URL is set but the PostgreSQL driver isn't installed "
                "(pip install 'psycopg[binary,pool]')."
            ) from exc

        return ConnectionPool(
            self.dsn,
            min_size=0,
            max_size=self.max_connections,
            timeout=self.pool_timeout,
            kwargs={"row_factory": dict_row, "connect_timeout": self.connect_timeout},
            # Verify a connection is still alive before handing it out. A
            # serverless instance can sit idle for minutes between requests,
            # long enough for the database (or the pgbouncer in front of it)
            # to have hung up — without this the next request fails with a
            # "connection already closed" that a retry would have avoided.
            check=ConnectionPool.check_connection,
            # Don't block process start on the database being reachable:
            # min_size=0 means nothing is dialled until a route actually
            # needs a row, so a database that's still waking up can't stop
            # the game from serving levels.
            open=True,
        )

    def _get_pool(self):
        if self._pool is None:
            with self._pool_lock:
                if self._pool is None:
                    self._pool = self._make_pool()
        return self._pool

    @contextmanager
    def _connect(self):
        try:
            pool = self._get_pool()
        except StorageError:
            raise
        except Exception as exc:
            raise StorageError(f"Could not reach the database: {exc}") from exc

        try:
            # `with pool.connection()` commits on clean exit and rolls back
            # on exception, then returns the connection to the pool.
            with pool.connection() as conn:
                yield conn
        except StorageError:
            raise
        except Exception as exc:
            if self._is_unique_violation(exc):
                raise
            if _is_connectivity_error(exc):
                raise StorageError(f"Database unavailable: {exc}") from exc
            raise

    def _schema_statements(self) -> list[str]:
        return SCHEMA

    def _adapt(self, sql: str) -> str:
        # psycopg uses %s placeholders. None of the SQL in base.py contains
        # a literal '?' outside a placeholder position, and no literal '%'
        # either, so a straight swap is safe and keeps the queries readable
        # in their SQLite-native form.
        return sql.replace("?", "%s")

    def _insert_returning_id(self, cur, sql: str, params: tuple) -> int:
        cur.execute(sql + " RETURNING id", params)
        row = cur.fetchone()
        return int(row["id"])

    def _is_unique_violation(self, exc: BaseException) -> bool:
        try:
            from psycopg import errors
        except ImportError:  # pragma: no cover
            return False
        return isinstance(exc, errors.UniqueViolation)

    def close(self) -> None:
        """Only used by tests and by a graceful local shutdown; serverless
        instances are torn down without ceremony."""
        if self._pool is not None:
            self._pool.close()
            self._pool = None


def _is_connectivity_error(exc: BaseException) -> bool:
    """A dropped connection or an unreachable host is a 503 (come back in a
    second), not a 500 (we have a bug). A constraint violation or a bad
    query is not."""
    try:
        import psycopg
        from psycopg import errors
    except ImportError:  # pragma: no cover
        return False
    if isinstance(exc, (errors.OperationalError, errors.AdminShutdown, errors.CannotConnectNow)):
        return True
    # psycopg_pool raises PoolTimeout when every connection is busy.
    return type(exc).__name__ in {"PoolTimeout", "PoolClosed"} or isinstance(exc, psycopg.OperationalError)
