"""Picks the storage backend from the environment.

The rule, in one sentence: a `DATABASE_URL` means PostgreSQL, no
`DATABASE_URL` on a normal host means the local SQLite file, and no
`DATABASE_URL` on a serverless host means no durable storage at all.

That last case is the honest one and the reason this indirection exists.
A serverless function's filesystem is read-only outside /tmp, and /tmp is
neither shared between instances nor kept between cold starts — a SQLite
file there would accept a signup, hand back a session token, and lose the
account minutes later. The affected routes answer 501 with an explanation
instead (see main.py), and everything that needs no database — level
generation, the daily challenge, score validation, guest play — keeps
working exactly as before.
"""

from __future__ import annotations

import os
from pathlib import Path

from .base import Store, StorageConfigurationError, StorageError, UsernameTaken
from .postgres_store import PostgresStore
from .sqlite_store import SqliteStore

DEFAULT_SQLITE_PATH = Path(__file__).resolve().parent.parent.parent / "data.db"

# Hosts that hand a function a read-only, per-instance filesystem. Their
# presence is what makes "no DATABASE_URL" mean "no storage" rather than
# "use the local file".
SERVERLESS_ENV_VARS = ("VERCEL", "AWS_LAMBDA_FUNCTION_NAME", "FUNCTIONS_WORKER_RUNTIME", "K_SERVICE")


def is_serverless(env: dict | None = None) -> bool:
    env = os.environ if env is None else env
    return any(env.get(name) for name in SERVERLESS_ENV_VARS)


def database_url(env: dict | None = None) -> str | None:
    """`DATABASE_URL` is the de-facto standard name and what Vercel's
    Neon/Supabase integrations set automatically. `POSTGRES_URL` is what
    Vercel Postgres sets, so it's accepted too — one less manual step
    between provisioning a database and the game finding it."""
    env = os.environ if env is None else env
    for name in ("DATABASE_URL", "POSTGRES_URL", "FAITHMATCH_DATABASE_URL"):
        value = (env.get(name) or "").strip()
        if value:
            return value
    return None


def create_store(env: dict | None = None) -> Store | None:
    """The configured store, or None when this deployment has nowhere
    durable to write."""
    env = os.environ if env is None else env

    url = database_url(env)
    if url:
        if url.startswith("sqlite://"):
            return SqliteStore(url[len("sqlite://"):] or DEFAULT_SQLITE_PATH)
        return PostgresStore(url)

    if is_serverless(env):
        return None

    return SqliteStore(env.get("FAITHMATCH_SQLITE_PATH") or DEFAULT_SQLITE_PATH)


__all__ = [
    "Store", "StorageError", "StorageConfigurationError", "UsernameTaken",
    "PostgresStore", "SqliteStore",
    "create_store", "database_url", "is_serverless", "DEFAULT_SQLITE_PATH",
]
