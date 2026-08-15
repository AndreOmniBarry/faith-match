"""Daily Blessing — a 3-level session, date-seeded, shared by every player on
a given UTC day. Deterministic from the calendar date alone, so every client
asking "what's today's session" gets byte-identical levels with no need to
coordinate or store anything server-side. Not endlessly replayable by design
— that's what makes it a "daily," not just another mode (streak/session
bookkeeping itself lives client-side in js/rewards.js, same as other local
progress)."""

from __future__ import annotations

import hashlib
from datetime import date, datetime, timezone

from .level_gen import get_level

DAILY_MODE = "daily-blessing"
INDEX_SPAN = 20_000  # keeps the daily rotation from ever repeating within a human lifetime
SESSION_LENGTH = 3


def _today_utc() -> date:
    return datetime.now(timezone.utc).date()


def _index_for_date(d: date) -> int:
    h = hashlib.sha256(f"faithmatch::daily::{d.isoformat()}".encode()).digest()
    return int.from_bytes(h[:4], "big") % INDEX_SPAN


def get_daily(for_date: str | None = None) -> dict:
    d = date.fromisoformat(for_date) if for_date else _today_utc()
    base_idx = _index_for_date(d)

    levels = []
    for i in range(SESSION_LENGTH):
        level = dict(get_level(DAILY_MODE, base_idx + i))
        # Daily levels are shorter and punchier than the mode's baseline
        # curve, and carry a score multiplier as the daily-engagement hook.
        level["moves"] = max(10, level["moves"] - 3)
        level["bonusMultiplier"] = max(level.get("bonusMultiplier") or 1.0, 1.5)
        level["date"] = d.isoformat()
        level["dailySlot"] = i
        levels.append(level)

    return {"date": d.isoformat(), "levels": levels}
