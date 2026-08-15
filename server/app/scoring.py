"""Score validation ("is this plausible?") and star calculation.

The client is never trusted for leaderboard placement — this is the one
place that decides. It doesn't need to be airtight (a determined cheater can
always beat a heuristic), it needs to catch the common cases: a modified
client posting an absurd score, or a replay/bot submitting suspiciously fast.
"""

from __future__ import annotations

# Generous per-move ceiling: covers a color-bomb-into-cascade on a 9x9 board.
# Anything above this, sustained across many moves, isn't a real playthrough.
MAX_POINTS_PER_MOVE = 480
MIN_MS_PER_MOVE = 160  # a human can't legally register a swap much faster than this


def stars_for(score: int, target: int) -> int:
    if target <= 0:
        return 0
    if score >= target * 1.6:
        return 3
    if score >= target * 1.25:
        return 2
    if score >= target:
        return 1
    return 0


def validate_score(score: int, moves_used: int, duration_ms: int | None) -> dict:
    reasons: list[str] = []
    moves_used = max(1, moves_used)

    ceiling = moves_used * MAX_POINTS_PER_MOVE
    if score < 0:
        reasons.append("negative_score")
    if score > ceiling:
        reasons.append("score_exceeds_move_ceiling")

    if duration_ms is not None:
        floor_ms = moves_used * MIN_MS_PER_MOVE
        if duration_ms < floor_ms:
            reasons.append("duration_too_short_for_moves")

    return {"accepted": len(reasons) == 0, "reasons": reasons}
