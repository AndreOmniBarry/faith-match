"""Daily Blessing — one challenge, date-seeded, shared by every player on a
given UTC day. Deterministic from the calendar date alone, so every client
asking "what's today's challenge" gets a byte-identical level with no need
to coordinate or store anything server-side. Not endlessly replayable by
design — that's what makes it a "daily," not just another mode (streak
bookkeeping itself lives client-side in js/rewards.js, same as other local
progress)."""

from __future__ import annotations

from datetime import date, datetime, timezone

from .level_gen import get_daily_level

DAILY_MODE = "daily-blessing"
SESSION_LENGTH = 1  # one challenge per day, not a multi-level session


def _today_utc() -> date:
    return datetime.now(timezone.utc).date()


def get_daily(for_date: str | None = None) -> dict:
    d = date.fromisoformat(for_date) if for_date else _today_utc()

    # get_daily_level() pins Daily to its own tuned, moderate difficulty band
    # (see its docstring in level_gen.py) instead of the old approach of
    # hashing the date into an arbitrary index on the global tier curve,
    # which saturated to near-max difficulty on the overwhelming majority of
    # dates. No extra moves penalty on top either, for the same reason —
    # the score multiplier below is the daily-engagement hook, not a harder
    # move budget.
    levels = []
    for i in range(SESSION_LENGTH):
        level = dict(get_daily_level(d.isoformat()))
        level["bonusMultiplier"] = max(level.get("bonusMultiplier") or 1.0, 1.5)
        level["date"] = d.isoformat()
        level["dailySlot"] = i
        levels.append(level)

    return {"date": d.isoformat(), "levels": levels}
