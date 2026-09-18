"""Check the offline fallback's collect/veil goals against the simulator.

js/content.js generates levels when the API is unreachable, and it has no
playout simulation — its goals are conservative stand-ins for the server's
calibrated ones (see offlineCollectGoal / offlineVeilRequired / the score
formula there). This plays those levels with the same simulator the server
calibrates with, so the offline path is held to the same "no unwinnable
level" bar, across every objective and on shaped boards as well as full
ones.

Feed it a JSON dump of offline levels, keyed "<mode>:<index>":

    node server/tools/dump_offline_levels.mjs > /tmp/offline.json
    python3 server/tools/verify_offline_goals.py /tmp/offline.json
"""

from __future__ import annotations

import json
import os
import random
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import level_gen as lg  # noqa: E402

PLAYOUTS = 15
FLOOR_WIN_RATE = 0.25


CHECKED_OBJECTIVES = ("collect", "veil", "cascade", "timed", "score")


def win_rate(key: str, lvl: dict) -> float:
    """Share of simulated playouts that clear this offline-generated level.

    Covers every objective, and plays the level's board mask, because past the
    endless range an offline level can be any of the five tasks on a board cut
    to a shape — checking only collect and veil on a full rectangle would now
    miss most of what the fallback produces."""
    objective = lvl["objective"]
    mask = tuple((r, c) for r, c in (lvl.get("mask") or []))
    board = (lvl["rows"], lvl["cols"], lvl["colors"], lvl["moves"])
    cells = (lvl.get("veil") or {}).get("cells") or []
    reqs = lvl.get("collect") or []
    wanted = frozenset(r["type"] for r in reqs)
    wins = 0
    for p in range(PLAYOUTS):
        rng = random.Random(lg._seed(f"offline::{key}", p))
        score, collected, left, total, chains = lg._simulate_playout(
            *board, rng,
            objective=objective if objective in ("collect", "veil") else "score",
            wanted=wanted, veil_cells=cells if objective == "veil" else None,
            blocked=mask)
        if objective == "collect":
            if all(collected.get(r["type"], 0) >= r["count"] for r in reqs):
                wins += 1
        elif objective == "veil":
            if total - left >= ((lvl["veil"].get("required") or len(cells))):
                wins += 1
        elif objective == "cascade":
            landed = sum(1 for d in chains if d >= lg.CASCADE_MIN_DEPTH)
            if landed >= (lvl.get("cascade") or {}).get("required", 1):
                wins += 1
        elif score >= lvl["target"]:
            wins += 1
    return wins / PLAYOUTS


def main():
    levels = json.load(open(sys.argv[1]))
    print(f"OFFLINE FALLBACK — {len(levels)} levels, {PLAYOUTS} playouts each, "
          f"floor {FLOOR_WIN_RATE*100:.0f}%")
    failures = []
    by_mode: dict = {}
    for key, lvl in levels.items():
        if lvl["objective"] not in CHECKED_OBJECTIVES:
            continue
        rate = win_rate(key, lvl)
        by_mode.setdefault(key.split(":")[0], []).append(rate)
        if rate < FLOOR_WIN_RATE:
            failures.append((key, lvl, rate))
    for mode, rates in sorted(by_mode.items()):
        rates.sort()
        print(f'  {mode}: {len(rates)} levels, worst {rates[0]*100:.0f}%, '
              f'5th pct {rates[len(rates)//20]*100:.0f}%, '
              f'median {rates[len(rates)//2]*100:.0f}%')
    if not failures:
        print(f"  no level below the {FLOOR_WIN_RATE*100:.0f}% floor")
        return 0
    print(f"  {len(failures)} level(s) below the floor:")
    for key, lvl, rate in failures:
        objective = lvl["objective"]
        if objective == "collect":
            goal = [r["count"] for r in lvl["collect"]]
        elif objective == "veil":
            goal = f'{lvl["veil"].get("required")} of {len(lvl["veil"]["cells"])}'
        elif objective == "cascade":
            goal = f'{(lvl.get("cascade") or {}).get("required")} chains'
        else:
            goal = lvl["target"]
        cut = f'/{len(lvl.get("mask") or [])}cut' if lvl.get("mask") else ""
        print(f'    {key} [{objective}] '
              f'{lvl["rows"]}x{lvl["cols"]}/{lvl["colors"]}c/{lvl["moves"]}m{cut}: '
              f'asks {goal}, win {rate*100:.0f}%')
    return 1


if __name__ == "__main__":
    sys.exit(main())
