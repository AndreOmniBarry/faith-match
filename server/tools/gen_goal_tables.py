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

# Levels to enumerate shapes over. The legacy curve saturates long before
# this; past ENDLESS_START_CHAPTER the era system keeps producing new boards,
# so the scan has to run deep enough to cover the range players will actually
# reach. Boards past the scan still work — _probe_collect_ladder() is the live
# fallback — they are just paid for on the request instead of at build time.
SCAN_LEVELS = 9000
MODES = ("grace-path", "harvest", "refiners-fire")

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

Keys:
  COLLECT_LADDERS         (rows, cols, colors, moves)                  full board
  MASKED_COLLECT_LADDERS  (rows, cols, colors, moves, mask)            shaped board
  CASCADE_LADDERS         (rows, cols, colors, moves, mask)            Chain of Grace
  SCORE_LADDERS           (rows, cols, colors, moves, mask)            endless score/timed

`mask` is the sorted tuple of blocked (row, col) cells an endless level's
board is cut to. A mask removes cells, which removes matches, so the full
rectangle's ladder does not describe it.

Built with GOAL_SIM_PLAYOUTS = {playouts}, CASCADE_SIM_PLAYOUTS = {cascadeplayouts},
SCORE_SIM_PLAYOUTS = {scoreplayouts},
SIM_RANDOM_MOVE_CHANCE = {randchance}.
Covering every board every mode produces over levels 0..{scan}.
"""

'''


def shape_keys():
    """Every board a collect or cascade goal can be calibrated on.

    The enumeration comes from level_gen.goal_shape_keys(), which reads the
    generator's own rules — the board the curve produced, plus the boards a
    stage finale's or an endless twist's modifiers ship after tightening the
    move budget or widening the palette. Asking the generator beats keeping a
    second copy of those rules in this script, which is exactly the kind of
    copy that goes quietly stale. It runs no simulation, so scanning every
    mode over nine thousand levels costs about two seconds.
    """
    collect, masked, cascade, score = set(), set(), set(), set()
    for mode in MODES:
        for index in range(SCAN_LEVELS):
            for objective, rows, cols, colors, moves, mask in lg.goal_shape_keys(mode, index):
                if objective == "cascade":
                    cascade.add((rows, cols, colors, moves, mask))
                elif objective in ("score", "timed"):
                    score.add((rows, cols, colors, moves, mask))
                elif mask:
                    masked.add((rows, cols, colors, moves, mask))
                else:
                    collect.add((rows, cols, colors, moves))
    # An endless level's board can carry any of the objectives depending only
    # on its seed, so every board one objective reaches, the others reach too.
    # Building each table over the union rather than over the levels that
    # happened to draw that objective is what stops a cold request falling
    # through to a live probe because of a coin flip.
    endless = cascade | score
    return sorted(collect), sorted(masked), sorted(endless), sorted(endless)


def _emit(lines, name, keys, probe, note):
    lines.append(f"# {note}\n{name} = {{\n")
    for i, key in enumerate(keys, 1):
        ladder = probe(key)
        lines.append(f"    {key}: {ladder},\n")
        print(f"  {name} {i}/{len(keys)} -> {ladder}", flush=True)
    lines.append("}\n\n")


def main():
    collect_keys, masked_keys, cascade_keys, score_keys = shape_keys()
    print(f"{len(collect_keys)} full-board collect shapes, "
          f"{len(masked_keys)} shaped-board collect shapes, "
          f"{len(cascade_keys)} cascade shapes, "
          f"{len(score_keys)} score shapes", flush=True)

    lines = [HEADER.format(playouts=lg.GOAL_SIM_PLAYOUTS,
                           cascadeplayouts=lg.CASCADE_SIM_PLAYOUTS,
                           scoreplayouts=lg.SCORE_SIM_PLAYOUTS,
                           randchance=lg.SIM_RANDOM_MOVE_CHANCE,
                           scan=SCAN_LEVELS - 1)]
    _emit(lines, "COLLECT_LADDERS", collect_keys,
          lambda k: lg._probe_collect_ladder(*k),
          "Full-board collect ladders. Key: (rows, cols, colors, moves)")
    _emit(lines, "MASKED_COLLECT_LADDERS", masked_keys,
          lambda k: lg._probe_collect_ladder(*k),
          "Shaped-board collect ladders. Key: (rows, cols, colors, moves, mask)")
    _emit(lines, "CASCADE_LADDERS", cascade_keys,
          lambda k: lg._cascade_ladder(*k),
          "Chain of Grace ladders. Key: (rows, cols, colors, moves, mask)")
    _emit(lines, "SCORE_LADDERS", score_keys,
          lambda k: lg._probe_score_ladder(*k),
          "Endless score/timed ladders. Key: (rows, cols, colors, moves, mask)")

    with open(OUT, "w") as fh:
        fh.write("".join(lines))
    print(f"wrote {os.path.abspath(OUT)}")


if __name__ == "__main__":
    main()
