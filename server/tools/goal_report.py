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
unwinnable in the first place. It covers every objective and every mode,
including the endless range past chapter 41, where a mode's chapter mixes
five kinds of level rather than repeating one.
"""

from __future__ import annotations

import os
import random
import statistics
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import level_gen as lg  # noqa: E402

INDICES = [0, 5, 14, 20, 30, 44, 50, 71, 100, 130, 150, 200, 250, 299,
           400, 500, 600, 750, 900, 1050, 1200, 1500, 2400, 5000, 20000]

# Chapters swept level by level: the onboarding, the stretch where both modes
# used to break, the old plateau, then the endless range — the opening of the
# first few eras, their peaks, and a couple of absurdly deep ones. An era's
# trough and its peak are different levels of difficulty by design, so both
# ends of one have to be in here or the sweep only ever measures the easy half.
SWEEP_CHAPTERS = [1, 2, 3, 4, 5, 8, 10, 14, 20, 30, 40,
                  41, 45, 50, 55, 60,          # era 0: open, climb, peak
                  61, 70, 80,                  # era 1
                  101, 110, 120,               # era 3
                  161, 180,                    # era 6
                  334, 500, 1000]
SWEEP_MODES = ["grace-path", "harvest", "refiners-fire"]

# No level should sit below this for a simulated average player, who plays no
# specials, no Combo Surge and no items — a real player has all three, so this
# is a floor on a pessimistic estimate, not a target.
FLOOR_WIN_RATE = 0.25


def old_collect_goal(index: int) -> int:
    """The formula this replaced: 14 + min(24, index // 3), plus -2..+3."""
    return 14 + min(24, index // 3)


def _mask_of(lvl: dict) -> tuple:
    return tuple((r, c) for r, c in (lvl.get("mask") or []))


def verify_level(mode: str, index: int, playouts: int) -> dict:
    """Play one level `playouts` times and report how often it was cleared.

    Dispatches on the level's own objective rather than on its mode, because
    past ENDLESS_START_CHAPTER a mode's chapter mixes objectives — a Harvest
    chapter at depth holds gathering, veil, chain, timed and score levels, and
    a report that assumed one task per mode would simply not look at four
    fifths of them.

    The simulated player plays no specials, no Combo Surge and no items, all
    of which a real player has, so every rate here is a floor.
    """
    lvl = lg.get_level(mode, index)
    objective = lvl["objective"]
    mask = _mask_of(lvl)
    board = (lvl["rows"], lvl["cols"], lvl["colors"], lvl["moves"])
    cells = (lvl.get("veil") or {}).get("cells") or []
    reqs = lvl.get("collect") or []
    wanted = frozenset(r["type"] for r in reqs)
    needs = {r["type"]: r["count"] for r in reqs}

    wins = 0
    reached = []
    for p in range(playouts):
        rng = random.Random(lg._seed(f"verify::{objective}::{mode}::{index}", p))
        score, collected, left, total, chains = lg._simulate_playout(
            *board, rng,
            objective=objective if objective in ("collect", "veil") else "score",
            wanted=wanted, veil_cells=cells if objective == "veil" else None,
            blocked=mask)
        if objective == "collect":
            reached.append(min(collected.get(k, 0) for k in wanted) if wanted else 0)
            if all(collected.get(k, 0) >= n for k, n in needs.items()):
                wins += 1
        elif objective == "veil":
            reached.append(total - left)
            if total - left >= (lvl.get("veil") or {}).get("required", 0):
                wins += 1
        elif objective == "cascade":
            landed = sum(1 for d in chains if d >= lg.CASCADE_MIN_DEPTH)
            reached.append(landed)
            if landed >= lvl["cascade"]["required"]:
                wins += 1
        else:                       # score and timed
            reached.append(score)
            if score >= lvl["target"]:
                wins += 1

    asks = {"collect": sorted(needs.values()),
            "veil": (lvl.get("veil") or {}).get("required", 0),
            "cascade": (lvl.get("cascade") or {}).get("required", 0)}.get(
                objective, lvl["target"])
    return {
        "mode": mode,
        "index": index,
        "objective": objective,
        "board": f'{lvl["rows"]}x{lvl["cols"]}/{lvl["colors"]}c/{lvl["moves"]}m'
                 + (f'/{len(mask)}cut' if mask else ""),
        "era": (lvl.get("era") or {}).get("title", "-"),
        "asks": asks,
        "reachable": int(statistics.median(reached)),
        "win_rate": wins / playouts,
        "aim": lg._goal_win_rate(lvl["calibration"]["difficultyEase"]),
    }


def verify_collect(index: int, playouts: int) -> dict:
    return verify_level("harvest", index, playouts)


def verify_veil(index: int, playouts: int) -> dict:
    return verify_level("refiners-fire", index, playouts)


def sweep(playouts: int) -> int:
    print(f"SWEEP — every level of {len(SWEEP_CHAPTERS)} chapters in "
          f"{len(SWEEP_MODES)} modes, {playouts} playouts each, "
          f"floor {FLOOR_WIN_RATE*100:.0f}%")
    failures = []
    by_objective: dict = {}
    for mode in SWEEP_MODES:
        rates = []
        for chapter in SWEEP_CHAPTERS:
            start = (chapter - 1) * lg.CHAPTER_SIZE
            for slot in range(lg.CHAPTER_SIZE):
                r = verify_level(mode, start + slot, playouts)
                rates.append(r["win_rate"])
                by_objective.setdefault(r["objective"], []).append(r["win_rate"])
                if r["win_rate"] < FLOOR_WIN_RATE:
                    failures.append(r)
        rates.sort()
        print(f'  {mode}: {len(rates)} levels, '
              f'worst {rates[0]*100:.0f}%, '
              f'5th pct {rates[len(rates)//20]*100:.0f}%, '
              f'median {rates[len(rates)//2]*100:.0f}%, '
              f'best {rates[-1]*100:.0f}%')
    print("  by objective:")
    for objective, rates in sorted(by_objective.items()):
        rates.sort()
        print(f'    {objective:<8} {len(rates):>5} levels, '
              f'worst {rates[0]*100:>3.0f}%, '
              f'median {rates[len(rates)//2]*100:>3.0f}%')
    if not failures:
        print(f"  no level below the {FLOOR_WIN_RATE*100:.0f}% floor")
        return 0
    print(f"  {len(failures)} level(s) below the floor:")
    for r in failures[:40]:
        print(f'    {r["mode"]} level {r["index"]} [{r["objective"]}] {r["board"]}: '
              f'asks {r["asks"]}, reachable {r["reachable"]}, '
              f'win {r["win_rate"]*100:.0f}% (aim {r["aim"]*100:.0f}%)')
    if len(failures) > 40:
        print(f"    ... and {len(failures) - 40} more")
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
