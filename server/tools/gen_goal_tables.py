"""Rebuild server/app/goal_tables.py — the prebuilt collect goal ladders.

The collect goals are calibrated by Monte Carlo playout (see
level_gen._probe_collect_ladder). That probe is deterministic but not cheap, and a serverless instance starts every cold
request with an empty lru_cache while the client abandons a chapter fetch
after 1.5s — so the results are checked in instead of recomputed at runtime.

_curve_shape() only produces a few dozen distinct boards across the whole
content range and saturates entirely past level ~600, so a table built over
the first few thousand levels covers every level the game can generate.

Veil goals are deliberately *not* in here: they depend on which cells a level
veils, not just on its board, so they are probed per level at generation time.
See level_gen._veil_ladder().

Run from the repo root after changing the difficulty curve, the simulator or
the playout count:

    python3 server/tools/gen_goal_tables.py

then re-run the calibration report to see what moved:

    python3 server/tools/goal_report.py
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import level_gen as lg  # noqa: E402

# Levels to enumerate shapes over. The curve saturates long before this; the
# margin is there so a future curve tweak is still covered without a thought.
SCAN_LEVELS = 3000

OUT = os.path.join(os.path.dirname(__file__), "..", "app", "goal_tables.py")

HEADER = '''"""Prebuilt collect/veil goal ladders — GENERATED, do not edit by hand.

Rebuild with:  python3 server/tools/gen_goal_tables.py

Each ladder is one sorted sample per simulated playout of how many of the
scarcer of the two chased symbols an average player gathered on that board.
level_gen._goal_from_ladder() reads the goal off these at the quantile the
level's ease asks for, so a goal is always a figure some share of simulated
players actually reached.

Veil goals are not here: they depend on a level's individual veil layout, not
just its board, so they are probed per level. See level_gen._veil_ladder().

Key: COLLECT_LADDERS  (rows, cols, colors, moves)

Built with GOAL_SIM_PLAYOUTS = {playouts}, SIM_RANDOM_MOVE_CHANCE = {randchance}.
Covering every board shape _curve_shape() produces over levels 0..{scan}.
"""

'''


def shape_keys():
    """Every board a collect goal can be calibrated on.

    A level's goal is calibrated on the board it actually ships, which for a
    stage finale means after its modifiers have tightened the move budget or
    widened the palette — so each of those variants is a key of its own.
    Enumerating them here is what keeps a cold request off the live probe path.
    """
    collect = set()
    for index in range(SCAN_LEVELS):
        chapter = index // lg.CHAPTER_SIZE + 1
        slot = index % lg.CHAPTER_SIZE
        is_finale = slot >= lg.CHAPTER_SIZE - 3
        ease = lg._chapter_ease(chapter) + (lg.FINALE_EASE_BUMP if is_finale else 0.0)
        ease = min(lg.CHAPTER_EASE_CAP, ease)
        shape = lg._ease(lg._curve_shape(index), ease)

        move_variants = {shape["moves"]}
        color_variants = {shape["colors"]}
        if is_finale:
            move_variants.add(max(lg.MIN_MOVES_FLOOR, round(shape["moves"] * 0.85)))
            color_variants.add(min(lg.SYMBOL_COUNT, shape["colors"] + 1))

        for moves in move_variants:
            for colors in color_variants:
                collect.add((shape["rows"], shape["cols"], colors, moves))
    return sorted(collect)


def main():
    collect_keys = shape_keys()
    print(f"{len(collect_keys)} collect shapes", flush=True)

    lines = [HEADER.format(playouts=lg.GOAL_SIM_PLAYOUTS,
                           randchance=lg.SIM_RANDOM_MOVE_CHANCE,
                           scan=SCAN_LEVELS - 1)]
    lines.append("COLLECT_LADDERS = {\n")
    for i, key in enumerate(collect_keys, 1):
        ladder = lg._probe_collect_ladder(*key)
        lines.append(f"    {key}: {ladder},\n")
        print(f"  collect {i}/{len(collect_keys)} {key} -> {ladder}", flush=True)
    lines.append("}\n")

    with open(OUT, "w") as fh:
        fh.write("".join(lines))
    print(f"wrote {os.path.abspath(OUT)}")


if __name__ == "__main__":
    main()
