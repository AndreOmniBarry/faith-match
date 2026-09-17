"""Check the offline fallback's collect/veil goals against the simulator.

js/content.js generates levels when the API is unreachable, and it has no
playout simulation — its goals are conservative stand-ins for the server's
calibrated ones (see offlineCollectGoal / offlineVeilRequired there). This
plays those levels with the same simulator the server calibrates with, so the
offline path is held to the same "no unwinnable level" bar.

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


def win_rate(key: str, lvl: dict) -> float:
    wins = 0
    for p in range(PLAYOUTS):
        rng = random.Random(lg._seed(f"offline::{key}", p))
        if lvl["objective"] == "collect":
            wanted = frozenset(r["type"] for r in lvl["collect"])
            _, collected, _, _ = lg._simulate_playout(
                lvl["rows"], lvl["cols"], lvl["colors"], lvl["moves"], rng,
                objective="collect", wanted=wanted)
            if all(collected.get(r["type"], 0) >= r["count"] for r in lvl["collect"]):
                wins += 1
        else:
            cells = lvl["veil"]["cells"]
            required = lvl["veil"].get("required") or len(cells)
            _, _, left, total = lg._simulate_playout(
                lvl["rows"], lvl["cols"], lvl["colors"], lvl["moves"], rng,
                objective="veil", veil_cells=cells)
            if total - left >= required:
                wins += 1
    return wins / PLAYOUTS


def main():
    levels = json.load(open(sys.argv[1]))
    print(f"OFFLINE FALLBACK — {len(levels)} levels, {PLAYOUTS} playouts each, "
          f"floor {FLOOR_WIN_RATE*100:.0f}%")
    failures = []
    by_mode: dict = {}
    for key, lvl in levels.items():
        if lvl["objective"] not in ("collect", "veil"):
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
        goal = ([r["count"] for r in lvl["collect"]] if lvl["objective"] == "collect"
                else f'{lvl["veil"].get("required")} of {len(lvl["veil"]["cells"])}')
        print(f'    {key} {lvl["rows"]}x{lvl["cols"]}/{lvl["colors"]}c/{lvl["moves"]}m: '
              f'asks {goal}, win {rate*100:.0f}%')
    return 1


if __name__ == "__main__":
    sys.exit(main())
