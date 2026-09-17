"""Process-wide handle on whatever database this deployment is using.

The queries themselves live in server/app/storage/ — this module is just
the single place the rest of the app asks "is there a database, and give
it to me". Keeping that behind one accessor is what lets main.py gate
routes on `db.is_available()` instead of on which host it happens to be
running on.

Configuration is one environment variable:

    DATABASE_URL=postgresql://user:pass@host/db    → PostgreSQL (production)
    (unset, on a normal host)                      → server/data.db (dev)
    (unset, on a serverless host)                  → no storage; those
                                                     routes answer 501

See server/README.md for the full setup, including which hosted providers
this has been built against.
"""

from __future__ import annotations

import logging
import threading

from .storage import (
    Store, StorageConfigurationError, StorageError, UsernameTaken,
    create_store, database_url, is_serverless,
)

log = logging.getLogger("faithmatch.db")

_store: Store | None = None
_store_resolved = False
_schema_ready = False
_lock = threading.Lock()


def get_store() -> Store | None:
    """The configured store, resolved once per process. None means this
    deployment has no durable storage — callers must handle that rather
    than assume a database exists."""
    global _store, _store_resolved
    if not _store_resolved:
        with _lock:
            if not _store_resolved:
                _store = create_store()
                _store_resolved = True
                log.info("storage backend: %s", _store.name if _store else "none")
    return _store


def is_available() -> bool:
    return get_store() is not None


def require_store() -> Store:
    """For call sites that have already been gated. Raises StorageError
    rather than returning None so a missed gate surfaces as a 503, never
    as an AttributeError on None."""
    store = get_store()
    if store is None:
        raise StorageError("This deployment has no persistent database configured.")
    return store


def init_schema(strict: bool = False) -> bool:
    """Create tables if they're missing. Idempotent, and safe to call from
    every cold start.

    Non-fatal by default: a database that's briefly unreachable at startup
    must not take down level generation, the daily challenge or guest play,
    none of which touch it. The database-backed routes will report 503 on
    their own until it comes back, and the next call retries this.
    """
    global _schema_ready
    store = get_store()
    if store is None:
        return False
    if _schema_ready:
        return True
    try:
        store.init_schema()
        _schema_ready = True
        return True
    except Exception as exc:
        log.warning("schema init deferred — database not ready yet: %s", exc)
        if strict:
            raise
        return False


def ensure_schema() -> None:
    """Lazy retry for the case where startup ran before the database was
    up. Cheap once it has succeeded (a bool check)."""
    if not _schema_ready:
        init_schema()


def describe() -> dict:
    """Backend summary for /api/health — enough to tell, from outside,
    whether a deployment can actually persist anything."""
    store = get_store()
    if store is None:
        return {
            "backend": "none",
            "persistent": False,
            "serverless": is_serverless(),
            "reachable": False,
        }
    return {
        "backend": store.name,
        "persistent": store.durable,
        "serverless": is_serverless(),
        "reachable": store.ping(),
    }


def reset_for_tests(store: Store | None) -> None:
    """Swap the process-wide store. Tests only."""
    global _store, _store_resolved, _schema_ready
    with _lock:
        _store = store
        _store_resolved = True
        _schema_ready = False


__all__ = [
    "get_store", "is_available", "require_store", "init_schema", "ensure_schema",
    "describe", "reset_for_tests", "StorageError", "StorageConfigurationError",
    "UsernameTaken", "database_url",
]
