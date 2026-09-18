"""Fit the offline fallback's score target to what the simulator measures.

js/content.js generates levels when the API is unreachable, and it has no
playout simulation. Its score target used to be a guess at the shape of a
calibrated one — `0.72 * ease * (60*moves + rows*cols*colors*9)` — which was
wrong in scale and in sign: it read a wider palette as a higher reachable
score, when a wider palette is what makes a board score less. It asked 6720
of the 9x9 / 8-colour / 10-move board the server calibrates to 570.

So the offline target is read off the same distribution every other goal is:
what a simulated player actually scores. This script samples that
distribution over every board the generator produces, fits it in log space,
and prints the constants js/content.js carries, plus the error spread and the
median-to-quantile ratios the win-rate mapping uses.

    python3 server/tools/fit_offline_score.py

Re-run it after changing the simulator, the scoring rules or the board range,
and copy the printed constants into the OFFLINE_SCORE_* block in
js/content.js. server/tools/verify_offline_goals.py is what checks the result.
"""

from __future__ import annotations

import math
import os
import random
import statistics
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import level_gen as lg  # noqa: E402

PLAYOUTS = 24
SIDES = (8, 9)
COLORS = range(5, lg.ENDLESS_SYMBOL_COUNT + 1)
MOVES = range(10, 30, 2)
CUTS = (0, 4, 8, 12)
# Win rates the ratio table is reported at — the range _goal_win_rate() spans.
RATIO_WIN_RATES = (0.85, 0.75, 0.65, 0.55, 0.45, 0.35, 0.25)


def _mask(rows: int, cols: int, count: int) -> tuple:
    """A representative cut of `count` cells: the corners first, the way the
    real mask shapes cut. The fit only needs how many cells are gone, not
    which — the sweep in goal_report.py checks the shapes themselves."""
    ring = [(0, 0), (0, cols - 1), (rows - 1, 0), (rows - 1, cols - 1),
            (0, 1), (0, cols - 2), (rows - 1, 1), (rows - 1, cols - 2),
            (1, 0), (1, cols - 1), (rows - 2, 0), (rows - 2, cols - 1)]
    return tuple(sorted(ring[:count]))


def sample() -> list:
    boards = []
    for side in SIDES:
        for colors in COLORS:
            for moves in MOVES:
                for cut in CUTS:
                    mask = _mask(side, side, cut)
                    scores = []
                    for p in range(PLAYOUTS):
                        rng = random.Random(lg._seed(
                            f"fit::{side}:{side}:{colors}:{moves}:{cut}", p))
                        score, _, _, _, _ = lg._simulate_playout(
                            side, side, colors, moves, rng,
                            objective="score", blocked=mask)
                        scores.append(score)
                    scores.sort()
                    boards.append(dict(side=side, colors=colors, moves=moves,
                                       cut=cut, ladder=scores))
                    print(f"  {side}x{side} {colors}c {moves}m {cut}cut "
                          f"median={scores[len(scores)//2]}", flush=True)
    return boards


def _least_squares(rows: list, cols: int) -> list:
    """Solve the normal equations for `rows` of (features..., y)."""
    a = [[sum(r[i]*r[j] for r in rows) for j in range(cols)] for i in range(cols)]
    b = [sum(r[i]*r[-1] for r in rows) for i in range(cols)]
    for i in range(cols):
        p = max(range(i, cols), key=lambda k: abs(a[k][i]))
        a[i], a[p] = a[p], a[i]
        b[i], b[p] = b[p], b[i]
        for k in range(i + 1, cols):
            f = a[k][i] / a[i][i]
            for c in range(i, cols):
                a[k][c] -= f * a[i][c]
            b[k] -= f * b[i]
    out = [0.0] * cols
    for i in reversed(range(cols)):
        out[i] = (b[i] - sum(a[i][j]*out[j] for j in range(i + 1, cols))) / a[i][i]
    return out


def _features(moves: int, free: int, colors: int) -> tuple:
    """log(median) is close to linear in these. The squared colour term is
    what makes it close rather than merely close-ish: each extra symbol costs
    less than the one before, so a single exponent on `colors` misses both
    ends of the palette range at once."""
    lc = math.log(colors)
    return (1.0, math.log(moves), math.log(free), lc, lc*lc)


def main() -> int:
    boards = sample()
    rows = []
    for b in boards:
        free = b["side"]*b["side"] - b["cut"]
        median = b["ladder"][len(b["ladder"]) // 2]
        rows.append(list(_features(b["moves"], free, b["colors"])) + [math.log(median)])
    coef = _least_squares(rows, 5)

    errs = []
    for b in boards:
        free = b["side"]*b["side"] - b["cut"]
        median = b["ladder"][len(b["ladder"]) // 2]
        pred = math.exp(sum(c*f for c, f in
                            zip(coef, _features(b["moves"], free, b["colors"]))))
        errs.append(pred / median)
    errs.sort()

    print(f"\n{len(boards)} boards, {PLAYOUTS} playouts each\n")
    print("  OFFLINE_SCORE_K          =", round(math.exp(coef[0])))
    print("  OFFLINE_SCORE_MOVE_EXP   =", round(coef[1], 4))
    print("  OFFLINE_SCORE_FREE_EXP   =", round(coef[2], 4))
    print("  OFFLINE_SCORE_COLOR_A    =", round(coef[3], 4))
    print("  OFFLINE_SCORE_COLOR_B    =", round(coef[4], 4))
    print(f"\n  predicted/measured median: p05 {errs[len(errs)//20]:.3f} "
          f"median {statistics.median(errs):.3f} "
          f"p95 {errs[-len(errs)//20]:.3f} max {errs[-1]:.3f}")

    print("\n  goal/median by win rate (OFFLINE_SCORE_RATIO_BASE/SLOPE fit these):")
    for w in RATIO_WIN_RATES:
        ratios = []
        for b in boards:
            ladder = b["ladder"]
            n = len(ladder)
            at = ladder[min(n - 1, max(0, int(n*(1.0 - w))))]
            ratios.append(at / ladder[n // 2])
        print(f"    win {w:.2f}: {statistics.median(ratios):.3f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
