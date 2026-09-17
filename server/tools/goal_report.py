"""Verify the calibrated collect/veil goals by playing the levels.

Prints, for a spread of levels across the content range, the goal the old
hand-written formulas asked for, the goal calibration now sets, and the share
of simulated average players who clear each — so a curve or simulator change
can be checked against real playouts rather than intuition.

The verification playouts are seeded from their own namespace, never the one
the calibration probes use, so this measures the goals rather than replaying
the samples they were read off.

    python3 server/tools/goal_report.py [playouts]
    python3 server/tools/goal_report.py sweep [playouts]

`sweep` checks every level of a spread of chapters instead of a sample of
levels, and lists any level a simulated average player clears less than
FLOOR_WIN_RATE of the time — the check that catches a goal the curve has
walked out from under, which is how Harvest and Refiner's Fire became
unwinnable in the first place.
"""

from __future__ import annotations

import os
import random
import statistics
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import level_gen as lg  # noqa: E402

INDICES = [0, 5, 14, 20, 30, 44, 50, 71, 100, 130, 150, 200, 250, 299,
           400, 500, 600, 900, 1200, 2000, 5000]

# Chapters swept level by level: the onboarding, the stretch where both modes
# used to break, the plateau, and a couple of absurdly deep ones.
SWEEP_CHAPTERS = [1, 2, 3, 4, 5, 8, 10, 14, 20, 30, 40, 60, 80, 120, 200, 334, 1000]

# No level should sit below this for a simulated average player, who plays no
# specials, no Combo Surge and no items — a real player has all three, so this
# is a floor on a pessimistic estimate, not a target.
FLOOR_WIN_RATE = 0.25


def old_collect_goal(index: int) -> int:
    """The formula this replaced: 14 + min(24, index // 3), plus -2..+3."""
    return 14 + min(24, index // 3)


def verify_collect(index: int, playouts: int) -> dict:
    lvl = lg.get_level("harvest", index)
    reqs = lvl["collect"] or []
    wanted = frozenset(r["type"] for r in reqs)
    needs = {r["type"]: r["count"] for r in reqs}
    wins = 0
    scarcest = []
    for p in range(playouts):
        rng = random.Random(lg._seed(f"verify::collect::{index}", p))
        _, collected, _, _ = lg._simulate_playout(
            lvl["rows"], lvl["cols"], lvl["colors"], lvl["moves"], rng,
            objective="collect", wanted=wanted)
        scarcest.append(min(collected.get(k, 0) for k in wanted))
        if all(collected.get(k, 0) >= n for k, n in needs.items()):
            wins += 1
    return {
        "index": index,
        "board": f'{lvl["rows"]}x{lvl["cols"]}/{lvl["colors"]}c/{lvl["moves"]}m',
        "old": old_collect_goal(index),
        "new": sorted(needs.values()),
        "reachable": int(statistics.median(scarcest)),
        "win_rate": wins / playouts,
        "aim": lg._goal_win_rate(lvl["calibration"]["difficultyEase"]),
    }


def verify_veil(index: int, playouts: int) -> dict:
    lvl = lg.get_level("refiners-fire", index)
    cells = (lvl.get("veil") or {}).get("cells") or []
    required = (lvl.get("veil") or {}).get("required") or 0
    wins = 0
    freed_all = 0
    freed = []
    for p in range(playouts):
        rng = random.Random(lg._seed(f"verify::veil::{index}", p))
        _, _, left, total = lg._simulate_playout(
            lvl["rows"], lvl["cols"], lvl["colors"], lvl["moves"], rng,
            objective="veil", veil_cells=cells)
        freed.append(total - left)
        if total - left >= required:
            wins += 1
        if left == 0:
            freed_all += 1
    return {
        "index": index,
        "board": f'{lvl["rows"]}x{lvl["cols"]}/{lvl["colors"]}c/{lvl["moves"]}m',
        "placed": len(cells),
        "old": len(cells),          # the old goal was "free every one of them"
        "new": required,
        "reachable": int(statistics.median(freed)),
        "win_rate": wins / playouts,
        "old_win_rate": freed_all / playouts,
        "aim": lg._goal_win_rate(lvl["calibration"]["difficultyEase"]),
    }


def sweep(playouts: int) -> int:
    print(f"SWEEP — every level of {len(SWEEP_CHAPTERS)} chapters, "
          f"{playouts} playouts each, floor {FLOOR_WIN_RATE*100:.0f}%")
    failures = []
    for mode, check in (("harvest", verify_collect), ("refiners-fire", verify_veil)):
        rates = []
        for chapter in SWEEP_CHAPTERS:
            start = (chapter - 1) * lg.CHAPTER_SIZE
            for slot in range(lg.CHAPTER_SIZE):
                r = check(start + slot, playouts)
                rates.append(r["win_rate"])
                if r["win_rate"] < FLOOR_WIN_RATE:
                    failures.append((mode, r))
        rates.sort()
        print(f'  {mode}: {len(rates)} levels, '
              f'worst {rates[0]*100:.0f}%, '
              f'5th pct {rates[len(rates)//20]*100:.0f}%, '
              f'median {rates[len(rates)//2]*100:.0f}%, '
              f'best {rates[-1]*100:.0f}%')
    if not failures:
        print(f"  no level below the {FLOOR_WIN_RATE*100:.0f}% floor")
        return 0
    print(f"  {len(failures)} level(s) below the floor:")
    for mode, r in failures:
        print(f'    {mode} level {r["index"]} {r["board"]}: '
              f'asks {r["new"]}, reachable {r["reachable"]}, '
              f'win {r["win_rate"]*100:.0f}% (aim {r["aim"]*100:.0f}%)')
    return 1


def main():
    args = sys.argv[1:]
    if args and args[0] == "sweep":
        sys.exit(sweep(int(args[1]) if len(args) > 1 else 15))
    playouts = int(args[0]) if args else 40

    print(f"HARVEST (collect) — {playouts} playouts per level")
    print(f'{"level":>6} {"board":>16} {"asked (old)":>11} {"asks (new)":>11} '
          f'{"reachable":>9} {"win%":>6} {"aim%":>5}')
    rows = [verify_collect(i, playouts) for i in INDICES]
    for r in rows:
        print(f'{r["index"]:>6} {r["board"]:>16} {r["old"]:>11} '
              f'{str(r["new"]):>11} {r["reachable"]:>9} '
              f'{r["win_rate"]*100:>5.0f}% {r["aim"]*100:>4.0f}%')
    print(f'  worst win rate: {min(r["win_rate"] for r in rows)*100:.0f}%, '
          f'median {statistics.median(r["win_rate"] for r in rows)*100:.0f}%')

    print()
    print(f"REFINER'S FIRE (veil) — {playouts} playouts per level")
    print(f'{"level":>6} {"board":>16} {"veils":>6} {"free all (old)":>14} '
          f'{"asks (new)":>10} {"reachable":>9} {"win%":>6} {"aim%":>5}')
    rows = [verify_veil(i, playouts) for i in INDICES]
    for r in rows:
        print(f'{r["index"]:>6} {r["board"]:>16} {r["placed"]:>6} '
              f'{r["old_win_rate"]*100:>13.0f}% {r["new"]:>10} {r["reachable"]:>9} '
              f'{r["win_rate"]*100:>5.0f}% {r["aim"]*100:>4.0f}%')
    print(f'  worst win rate: {min(r["win_rate"] for r in rows)*100:.0f}%, '
          f'median {statistics.median(r["win_rate"] for r in rows)*100:.0f}%')


if __name__ == "__main__":
    main()
