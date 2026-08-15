"""Daily Blessing — one rotating, date-seeded level shared by every player on a
given UTC day. Deterministic from the calendar date alone, so every client
that asks "what's today's level" gets byte-identical config with no need to
coordinate or store anything."""

from __future__ import annotations

import hashlib
from datetime import date, datetime, timezone

from .level_gen import get_level

DAILY_MODE = "daily-blessing"
INDEX_SPAN = 20_000  # keeps the daily rotation from ever repeating within a human lifetime


def _today_utc() -> date:
    return datetime.now(timezone.utc).date()


def _index_for_date(d: date) -> int:
    h = hashlib.sha256(f"faithmatch::daily::{d.isoformat()}".encode()).digest()
    return int.from_bytes(h[:4], "big") % INDEX_SPAN


def get_daily(for_date: str | None = None) -> dict:
    d = date.fromisoformat(for_date) if for_date else _today_utc()
    idx = _index_for_date(d)
    level = dict(get_level(DAILY_MODE, idx))
    # Daily levels are shorter and punchier than the mode's baseline curve,
    # and carry a score multiplier as the daily-engagement hook.
    level["moves"] = max(10, level["moves"] - 3)
    level["bonusMultiplier"] = 1.5
    level["date"] = d.isoformat()
    return level
