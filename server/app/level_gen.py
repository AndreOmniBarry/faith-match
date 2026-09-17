"""
Faith Match — level generation & difficulty calibration engine.

This is the piece that is genuinely easier to get right in Python than in a
phone webview: instead of hand-guessing "moves=18, target=5000" the way the
original prototype did, every level is calibrated by *simulating* a batch of
playouts of a candidate board and setting the target relative to what an
average player would actually score. That's the "ahead of its time" bit the
product asked for — most match-3 games (and this app's own original
prototype) ship hand-tuned numbers; here the numbers are derived and
reproducible.

Everything here is deterministic for a given (mode, index): same seed in,
same level out, forever. No external state, no network — safe to run in a
tight loop and to cache aggressively.
"""

from __future__ import annotations

import hashlib
import math
import random
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Optional

from . import goal_tables

# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------

# Per-chapter ease table — chapters 1-3 are a deliberately gentle
# onboarding, then the climb becomes a real one. Replaces a single flat
# constant so a chapter has its own difficulty identity, not just a smooth
# continuous ramp with no distinct steps. Lower ease = kinder (more moves,
# lower veil density/score target relative to _ease()'s formula); >1.0 sits
# on the harder-than-neutral side. Values are indexed by chapter (1-based);
# `_chapter_ease()` extrapolates past the table's tail for chapter 16+.
CHAPTER_EASE_TABLE = {
    1: 0.72, 2: 0.72, 3: 0.72,
    4: 0.85, 5: 0.85, 6: 0.85,
    7: 0.95, 8: 0.95, 9: 0.95,
    10: 1.05, 11: 1.05, 12: 1.05,
    13: 1.15, 14: 1.15, 15: 1.15,
}
CHAPTER_EASE_TAIL_CHAPTER = 15       # last chapter explicitly in the table
CHAPTER_EASE_TAIL_VALUE = 1.15       # its ease value, extrapolation's base
CHAPTER_EASE_TAIL_STEP = 0.015       # per-chapter increase beyond the table
CHAPTER_EASE_CAP = 1.45              # hard ceiling — never harder than this
FINALE_EASE_BUMP = 0.15              # finale levels: chapter ease + this, same cap
VEIL_DENSITY_CEILING = 0.22          # most of the board a veil field may ever
                                      # cover, before *and* after easing
MIN_MOVES_FLOOR = 10                 # absolute floor, independent of ease —
                                      # the lesson from the Daily Blessing bug:
                                      # no tier should ever be able to produce
                                      # a near-unwinnable move budget.

# Backward-compatible aliases some call sites still reference directly.
DIFFICULTY_EASE = CHAPTER_EASE_TABLE[1]

SYMBOL_COUNT = 8          # total distinct faith-symbol types available client-side
CHAPTER_SIZE = 15         # levels per chapter, mirrors the client's level-select grouping
BREATHER_EVERY = 5        # every Nth level inside a run is deliberately a notch easier
SIM_PLAYOUTS = 18         # Monte Carlo playouts used to calibrate a score target
SIM_RANDOM_MOVE_CHANCE = 0.22   # fraction of moves a simulated "average player" plays sub-optimally

# This build's documented content range. Not hand-authored rows — the
# generator below is already unbounded and deterministic; this is the range
# we're calling "released" for now, per the "scope in batches" plan. Raised
# again, 1300 to 2000, then to 100000 -- get_level()/get_chapter() were
# never actually bounded by this constant (no ceiling check exists in
# either function or in main.py's routes beyond index >= 0); it's purely
# a scope number the World Map used to size itself against. Confirmed
# stable and fast (~30ms/level, ~0.4s/chapter cold, then lru_cache-hit)
# all the way out to chapter 3334 / index 50000 -- _chapter_ease() plateaus
# at CHAPTER_EASE_CAP with no tail dependency, same as the 1300->2000 bump.
# 100000 is a practical "effectively endless" bound (no player will ever
# grind to it) rather than a real limit -- paired with the World Map now
# lazily loading more chapters as the player nears the bottom of the trail
# (see renderWorldMap in js/screens.js) instead of pre-rendering a fixed
# small batch and just stopping, which is what previously made the map
# read as closing after a few chapters. js/content.js mirrors this
# constant exactly, and js/screens.js's World Map reads it from there (not
# a hardcoded copy) as its lazy-load safety ceiling.
CONTENT_CEILING_LEVELS = 100000

# Stage-finale modifier axes (levels 13-15 of every chapter). Seeded per
# (mode, chapter, slot), independent of each other, so combinations don't
# repeat predictably: 4 pieces x 4 tasks x 6 skins x 5 constraints = 480
# per slot x 3 slots = comfortably past 1000 distinct non-repeating finales
# without hand-authoring any of them — same principle as the level curve.
FINALE_PIECES = ["wildcard", "lockedChain", "doublePoints", "shrinking"]
FINALE_TASKS = ["score", "collect", "veil", "timed"]
FINALE_SKINS = ["dawn", "ember", "tempest", "hallowed", "midnight", "harvest"]
FINALE_CONSTRAINTS = ["tighterMoves", "hazardTile", "raisedTarget", "moreColors", "noEasing"]


def _seed(mode: str, index: int) -> int:
    """Deterministic 63-bit seed for (mode, index). Stable across processes/hosts."""
    h = hashlib.sha256(f"faithmatch::{mode}::{index}".encode()).digest()
    return int.from_bytes(h[:8], "big") & 0x7FFFFFFFFFFFFFFF


# ---------------------------------------------------------------------------
# Difficulty curve — pure function of level index, gated by DIFFICULTY_EASE
# ---------------------------------------------------------------------------

def _curve_shape(index: int) -> dict:
    """
    Baseline shape before easing, loosely modeled on how mobile match-3 games
    typically ramp: board grows, palette widens, move budget tightens — but
    with periodic breather levels so the ramp never becomes a hard wall
    (that wall is what causes the frustration/abandonment the product
    explicitly wants to avoid).
    """
    tier = index // 40  # every 40 levels, push the ceiling out a bit further

    rows = cols = min(9, 8 + tier // 3)
    colors = min(SYMBOL_COUNT, 5 + tier // 2)

    # Move budget: ramps down from 24 to a floor of 13, with breather levels
    # bumping it back up slightly so players get periodic relief.
    ramp = min(11, index // 6)
    moves = 24 - ramp
    if index % BREATHER_EVERY == 0 and index > 0:
        moves += 2
    moves = max(13, moves)

    # Veil (obstacle) density only matters for the 'veil' objective mode, but
    # we compute it here so it still respects the same global ramp. Floored
    # at 0.08 (not 0) — a Refiner's Fire level with zero veils has nothing to
    # refine: the win condition is already satisfied before the first move.
    veil_density = min(VEIL_DENSITY_CEILING, 0.08 + index * 0.0035)

    return {"rows": rows, "cols": cols, "colors": colors, "moves": moves, "veil_density": veil_density}


def _chapter_ease(chapter: int) -> float:
    """Ease for a given chapter (1-based) — see CHAPTER_EASE_TABLE's comment.
    Chapters 1-15 read straight from the table; beyond that, extrapolate a
    slow, capped climb rather than holding flat or leaving it undefined,
    since content is meant to keep growing past the table's tail."""
    if chapter in CHAPTER_EASE_TABLE:
        return CHAPTER_EASE_TABLE[chapter]
    if chapter < 1:
        return CHAPTER_EASE_TABLE[1]
    extra = CHAPTER_EASE_TAIL_VALUE + CHAPTER_EASE_TAIL_STEP * (chapter - CHAPTER_EASE_TAIL_CHAPTER)
    return min(CHAPTER_EASE_CAP, extra)


def _ease(shape: dict, ease: float) -> dict:
    """Lower `ease` = kinder (more bonus moves, fewer veils, lower score
    target relative to what a simulated player achieves). ease=1.0 is
    "no adjustment" baseline; finale levels intentionally use a higher ease
    (chapter ease + FINALE_EASE_BUMP) to be genuinely harder, not just
    differently flavored. `moves` is floored at MIN_MOVES_FLOOR regardless of
    how high `ease` climbs — no chapter tier should ever be able to produce
    the kind of near-unwinnable move budget the Daily Blessing bug did."""
    eased = dict(shape)
    eased["moves"] = max(MIN_MOVES_FLOOR, round(shape["moves"] * (2 - ease)))
    # Clamped back to the curve's own ceiling: `ease` climbs to
    # CHAPTER_EASE_CAP, which used to multiply the density to 0.32 and freeze
    # a third of the board. Measured, that is not a harder Refiner's Fire but
    # a worse one — the veiled cells split the board into segments nothing
    # falls through, so most of the level is a handful of legal moves and
    # repeated deadlock reshuffles.
    eased["veil_density"] = round(min(VEIL_DENSITY_CEILING,
                                      shape["veil_density"] * ease), 4)
    return eased


# ---------------------------------------------------------------------------
# Minimal match-3 simulator (only what's needed to calibrate difficulty —
# this deliberately mirrors the client engine's core rules, not its specials,
# so the estimate stays fast and representative of baseline scoring)
# ---------------------------------------------------------------------------

def _gen_board(rng: random.Random, rows: int, cols: int, colors: int) -> list[list[int]]:
    def would_run(board, r, c, t):
        if c >= 2 and board[r][c - 1] == t and board[r][c - 2] == t:
            return True
        if r >= 2 and board[r - 1][c] == t and board[r - 2][c] == t:
            return True
        return False

    board = [[0] * cols for _ in range(rows)]
    for r in range(rows):
        for c in range(cols):
            for _ in range(30):
                t = rng.randrange(colors)
                if not would_run(board, r, c, t):
                    break
            board[r][c] = t
    return board


def _match_view(board, rows, cols, veil):
    """The board as *matching* sees it: a veiled cell reads as -1 and so can
    never be part of a run, which is js/engine.js's typeAt() rule. With no
    veils the board itself is the view — no copy, and every run scan below
    stays the plain indexing it has always been, so a score-only calibration
    costs exactly what it did before veils existed."""
    if veil is None:
        return board
    return [[-1 if veil[r][c] > 0 else board[r][c] for c in range(cols)]
            for r in range(rows)]


def _line_run(view, rows, cols, r, c) -> int:
    t = view[r][c]
    if t < 0:
        return 0
    run = 1
    cc = c - 1
    while cc >= 0 and view[r][cc] == t:
        run += 1
        cc -= 1
    cc = c + 1
    while cc < cols and view[r][cc] == t:
        run += 1
        cc += 1
    if run >= 3:
        return run
    run = 1
    rr = r - 1
    while rr >= 0 and view[rr][c] == t:
        run += 1
        rr -= 1
    rr = r + 1
    while rr < rows and view[rr][c] == t:
        run += 1
        rr += 1
    return run if run >= 3 else 1


def _find_runs(view, rows, cols):
    """Returns list of (length, cells[(r,c),...]) for every horizontal/vertical run >=3."""
    runs = []
    for r in range(rows):
        c = 0
        while c < cols:
            t = view[r][c]
            if t < 0:
                c += 1
                continue
            c2 = c + 1
            while c2 < cols and view[r][c2] == t:
                c2 += 1
            if c2 - c >= 3:
                runs.append((c2 - c, [(r, k) for k in range(c, c2)]))
            c = c2
    for c in range(cols):
        r = 0
        while r < rows:
            t = view[r][c]
            if t < 0:
                r += 1
                continue
            r2 = r + 1
            while r2 < rows and view[r2][c] == t:
                r2 += 1
            if r2 - r >= 3:
                runs.append((r2 - r, [(k, c) for k in range(r, r2)]))
            r = r2
    return runs


def _has_move(board, rows, cols, veil=None) -> bool:
    view = _match_view(board, rows, cols, veil)

    def swap_run_ok(r1, c1, r2, c2):
        t1, t2 = view[r1][c1], view[r2][c2]
        if t1 == t2 or t1 < 0 or t2 < 0:
            return False
        view[r1][c1], view[r2][c2] = t2, t1
        ok = _line_run(view, rows, cols, r1, c1) >= 3 or _line_run(view, rows, cols, r2, c2) >= 3
        view[r1][c1], view[r2][c2] = t1, t2
        return ok

    for r in range(rows):
        for c in range(cols):
            if c + 1 < cols and swap_run_ok(r, c, r, c + 1):
                return True
            if r + 1 < rows and swap_run_ok(r, c, r + 1, c):
                return True
    return False


def _points_for(length: int) -> int:
    return 30 + (length - 3) * 40


def _collapse_segment(board, c, top, bottom, colors, rng) -> None:
    if bottom < top:
        return
    write_row = bottom
    for r in range(bottom, top - 1, -1):
        if board[r][c] is not None:
            if write_row != r:
                board[write_row][c] = board[r][c]
                board[r][c] = None
            write_row -= 1
    for r in range(write_row, top - 1, -1):
        board[r][c] = rng.randrange(colors)


def _collapse_refill(board, rows, cols, colors, rng, veil=None):
    """Tiles fall within column segments split at every veiled row — a veiled
    cell is a fixed obstacle nothing falls into or through, mirroring
    js/engine.js's collapseAndRefill(). With no veils each column is a single
    segment, which is the whole-column collapse this always did."""
    for c in range(cols):
        seg_bottom = rows - 1
        if veil is not None:
            for r in range(rows - 1, -1, -1):
                if veil[r][c] > 0:
                    _collapse_segment(board, c, r + 1, seg_bottom, colors, rng)
                    seg_bottom = r - 1
        _collapse_segment(board, c, 0, seg_bottom, colors, rng)


def _crack_veils(veil, rows, cols, matched) -> None:
    """One layer off every veiled cell orthogonally adjacent to a cell that
    just cleared — js/engine.js's crackAdjacentVeils()."""
    for r in range(rows):
        for c in range(cols):
            if veil[r][c] <= 0:
                continue
            for ar, ac in ((r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)):
                if (ar, ac) in matched:
                    veil[r][c] -= 1
                    break


def _resolve_cascades(board, rows, cols, colors, rng, veil=None, collected=None) -> int:
    score = 0
    combo = 0
    while True:
        runs = _find_runs(_match_view(board, rows, cols, veil), rows, cols)
        if not runs:
            break
        matched = set()
        for length, cells in runs:
            score += round(_points_for(length) * (1 + 0.4 * combo))
            matched.update(cells)
        combo += 1
        for r, c in matched:
            if collected is not None:
                t = board[r][c]
                if t is not None:
                    collected[t] = collected.get(t, 0) + 1
            board[r][c] = None
        if veil is not None:
            _crack_veils(veil, rows, cols, matched)
        _collapse_refill(board, rows, cols, colors, rng, veil)
    return score


def _swap_rank(cand, view, rows, cols, veil, objective, wanted):
    """How much a candidate swap is worth to a player *playing the level's
    objective* — the same weighting the client's own move scorer uses in
    cometCellScore(): a wanted symbol on a collect level, a match beside a
    veil on a veil level, otherwise just the longest run."""
    if objective == "collect":
        return (1 if (cand[3] in wanted or cand[4] in wanted) else 0, cand[2])
    if objective == "veil":
        near = 0
        for r, c in (cand[0], cand[1]):
            for ar, ac in ((r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)):
                if 0 <= ar < rows and 0 <= ac < cols and veil[ar][ac] > 0:
                    near += 1
        return (near, cand[2])
    return (cand[2],)


def _pick_swap(board, rows, cols, rng, greedy: bool, veil=None,
               objective="score", wanted=frozenset()):
    """Find a valid adjacent swap. Greedy = a player going after the level's
    objective (see _swap_rank); non-greedy = any valid swap at random (an
    average player). This mix is what makes the simulated medians a realistic
    "typical player" figure instead of a best-case one."""
    view = _match_view(board, rows, cols, veil)
    candidates = []
    for r in range(rows):
        for c in range(cols):
            for dr, dc in ((0, 1), (1, 0)):
                r2, c2 = r + dr, c + dc
                if r2 >= rows or c2 >= cols:
                    continue
                t1, t2 = view[r][c], view[r2][c2]
                if t1 == t2 or t1 < 0 or t2 < 0:
                    continue
                view[r][c], view[r2][c2] = t2, t1
                best = max(_line_run(view, rows, cols, r, c),
                           _line_run(view, rows, cols, r2, c2))
                view[r][c], view[r2][c2] = t1, t2
                if best >= 3:
                    candidates.append(((r, c), (r2, c2), best, t1, t2))
    if not candidates:
        return None
    if greedy:
        ranked = [_swap_rank(cand, view, rows, cols, veil, objective, wanted)
                  for cand in candidates]
        top = max(ranked)
        pool = [cand for cand, rank in zip(candidates, ranked) if rank == top]
        return rng.choice(pool)
    return rng.choice(candidates)


def _simulate_playout(rows, cols, colors, moves, rng, objective="score",
                      wanted=frozenset(), veil_cells=None) -> tuple:
    """One playout. Returns (score, collected_by_type, veils_left, veils_total).

    Called with its default arguments this is the score-only playout the score
    targets have always been calibrated with — move for move and random draw
    for random draw. The collect/veil instrumentation only adds counters and
    the veil rules; it never changes how a veil-free board plays."""
    board = _gen_board(rng, rows, cols, colors)
    veil = None
    veils_total = 0
    if veil_cells:
        veil = [[0] * cols for _ in range(rows)]
        for cell in veil_cells:
            r, c, layers = cell[0], cell[1], cell[2]
            if r < rows and c < cols:
                veil[r][c] = layers
                veils_total += 1
    collected = {} if objective == "collect" else None
    score = 0
    for _ in range(moves):
        if not _has_move(board, rows, cols, veil):
            free = [(r, c) for r in range(rows) for c in range(cols)
                    if veil is None or veil[r][c] == 0]
            flat = [board[r][c] for r, c in free]
            rng.shuffle(flat)
            for i, (r, c) in enumerate(free):
                board[r][c] = flat[i]
            continue
        greedy = rng.random() > SIM_RANDOM_MOVE_CHANCE
        swap = _pick_swap(board, rows, cols, rng, greedy, veil, objective, wanted)
        if swap is None:
            break
        (r1, c1), (r2, c2) = swap[0], swap[1]
        board[r1][c1], board[r2][c2] = board[r2][c2], board[r1][c1]
        score += _resolve_cascades(board, rows, cols, colors, rng, veil, collected)
    veils_left = 0
    if veil is not None:
        veils_left = sum(1 for r in range(rows) for c in range(cols) if veil[r][c] > 0)
    return score, (collected or {}), veils_left, veils_total


def _calibrate_target(shape: dict, rng: random.Random, ease: float) -> tuple[int, int]:
    """Runs SIM_PLAYOUTS simulated playouts and returns (target, median_sim_score)."""
    scores = sorted(
        _simulate_playout(shape["rows"], shape["cols"], shape["colors"], shape["moves"], rng)[0]
        for _ in range(SIM_PLAYOUTS)
    )
    median = scores[len(scores) // 2]
    # Target is a fraction of what a mixed-skill simulated player achieves,
    # then eased — reachable without perfect play, still a real goal.
    target_ratio = 0.72 * ease
    target = max(200, round(median * target_ratio / 10) * 10)
    return target, median


# ---------------------------------------------------------------------------
# Goal calibration — collect and veil goals, from the same simulation
#
# The score target has always been simulated (see _calibrate_target). The
# collect and veil goals were not: they came from hand-written formulas that
# climbed with the level index while the move budget was *falling*, so they
# crossed what any player could reach and kept going. Measured against the
# simulator, Harvest stopped being winnable around level 50 (asking ~32 of
# each of two symbols where a simulated player gathers 26, then ~40 against 6
# by level 300) and Refiner's Fire around level 71. Both goals are now read
# off the same playouts, so neither can outrun the board it is set on.
#
# Both probes are keyed by *board shape* (rows, cols, colors, moves), not by
# level index: _curve_shape() only produces a few dozen distinct shapes across
# the whole content range, and it saturates entirely past ~level 600. So the
# lru_cache below collapses every level in the game onto a handful of probes,
# and a level costs nothing beyond its own score calibration once the shape
# has been seen. The probes take their own seed from the shape, never the
# level's rng, which keeps every existing score target bit-identical and
# keeps a goal reproducible no matter which level asks for it first.
# ---------------------------------------------------------------------------

VEIL_SIM_PLAYOUTS = 12       # playouts per veil goal. Lower than
                             # GOAL_SIM_PLAYOUTS because this one runs per
                             # level rather than per board shape, so it is
                             # paid on every cold request — see _veil_ladder().
GOAL_SIM_PLAYOUTS = 36       # playouts per goal probe. Twice SIM_PLAYOUTS
                             # because a goal is an integer in the single
                             # digits at depth, where one sample of noise in
                             # the quantile is a whole step of difficulty —
                             # and because these probes are prebuilt
                             # (goal_tables.py), so the samples are paid for
                             # once at build time, not per request.

# The share of simulated average players who should be able to finish the
# level. Interpolated on `ease`, so a chapter-1 level is generous and a late
# finale genuinely bites, and the goal is set at that quantile of what the
# playouts actually achieved. The simulator plays no specials, no Combo
# Surge and no items, all of which a real player has, so a real win rate
# sits *above* these numbers — they are a floor, deliberately.
GOAL_WIN_RATE_EASY = 0.88    # at the kindest ease in CHAPTER_EASE_TABLE
GOAL_WIN_RATE_HARD = 0.55    # at CHAPTER_EASE_CAP
COLLECT_MIN_GOAL = 3         # a goal below this reads as no goal at all
VEIL_MIN_REQUIRED = 2
GOAL_SAFETY_SAMPLES = 6.0    # sets how far below the measured quantile a goal
                             # is read, as GOAL_SAFETY_SAMPLES / sqrt(samples)
                             # ladder steps — see _goal_from_ladder().
GOAL_JITTER = 0.08           # +/- this share of the goal, so two levels on the
                             # same board still differ. Proportional, not the
                             # flat +/-1 it started as: at depth a goal is 3 or
                             # 4 pieces, where +1 is a third harder, and that
                             # was enough on its own to push levels under
                             # their intended win rate.


def _goal_win_rate(ease: float) -> float:
    """Simulated-player win rate a level of this ease should aim for."""
    lo, hi = CHAPTER_EASE_TABLE[1], CHAPTER_EASE_CAP
    span = hi - lo
    t = 0.0 if span <= 0 else min(1.0, max(0.0, (ease - lo) / span))
    return GOAL_WIN_RATE_EASY + (GOAL_WIN_RATE_HARD - GOAL_WIN_RATE_EASY) * t


def _goal_from_ladder(ladder: tuple, win_rate: float) -> int:
    """Largest goal that at least `win_rate` of the playouts in `ladder`
    (sorted ascending) reached. Picking the value at index n*(1-win_rate)
    leaves n-index playouts at or above it, which is the definition.

    Then a safety step down, because a ladder is a sample and the quantile it
    reports carries sampling noise whose two directions cost very different
    things: a goal a step low is a slightly generous level, a goal a step high
    can be a level nobody finishes, which is the failure this whole module is
    here to prevent. The step shrinks as 1/sqrt(samples), so a goal read off a
    small sample is held further back than one read off a large one."""
    if not ladder:
        return 0
    n = len(ladder)
    idx = int(n * (1.0 - win_rate)) - max(1, round(GOAL_SAFETY_SAMPLES / math.sqrt(n)))
    return ladder[min(n - 1, max(0, idx))]


@lru_cache(maxsize=512)
def _probe_collect_ladder(rows: int, cols: int, colors: int, moves: int) -> tuple:
    """Per-playout count of the *scarcer* of the two chased symbols, sorted
    ascending. The scarcer one is what decides the level: a collect win needs
    every requirement met, so calibrating on the weaker of the two is what
    makes the pair jointly reachable rather than each one separately."""
    rng = random.Random(_seed(f"collect-ladder::{rows}x{cols}::{colors}c", moves))
    wanted = (0, 1) if colors >= 2 else (0,)
    out = []
    for _ in range(GOAL_SIM_PLAYOUTS):
        _, collected, _, _ = _simulate_playout(rows, cols, colors, moves, rng,
                                               objective="collect", wanted=wanted)
        out.append(min(collected.get(k, 0) for k in wanted))
    return tuple(sorted(out))


def _veil_ladder(rows: int, cols: int, colors: int, moves: int, cells: tuple) -> tuple:
    """Per-playout count of veiled cells freed outright, sorted ascending,
    for *this level's own veil layout*.

    Unlike collect, a veil goal cannot be calibrated from the board shape
    alone. Measured across layouts of the same size, which cells are veiled
    swings the result more than the board does: on a level-592 board a player
    frees a median of 3 veils on the layout that level ships and 5 to 6 on an
    average layout of the same count, because veiled cells nothing falls
    through cut the board into segments and a clustered layout strands whole
    regions. So this probes the real layout, and is the one part of
    calibration that cannot be read from goal_tables.py.
    """
    placed = [list(cell) for cell in cells]
    out = []
    for p in range(VEIL_SIM_PLAYOUTS):
        rng = random.Random(_seed(f"veil-goal::{rows}x{cols}::{colors}c::{moves}m", p))
        _, _, left, total = _simulate_playout(rows, cols, colors, moves, rng,
                                              objective="veil", veil_cells=placed)
        out.append(total - left)
    return tuple(sorted(out))


def _collect_ladder(rows: int, cols: int, colors: int, moves: int) -> tuple:
    """Prebuilt ladder for this board if we have one, else probe it now.

    The probes are deterministic, so their results are checked in as
    goal_tables.py (built by server/tools/gen_goal_tables.py) rather than
    re-derived on every cold start — a serverless instance starts with an
    empty lru_cache, and the client gives up on a chapter after 1.5s. The
    table covers every shape _curve_shape() produces, so the probe below is
    the safety net for a curve change that outruns a table rebuild, not the
    normal path."""
    cached = goal_tables.COLLECT_LADDERS.get((rows, cols, colors, moves))
    if cached is not None:
        return cached
    return _probe_collect_ladder(rows, cols, colors, moves)

# ---------------------------------------------------------------------------
# Public: level config assembly (objective, collect targets, veil placement)
# ---------------------------------------------------------------------------

STORY_NAMES = [
    "A Gentle Start", "Rising Faith", "Steady Hands", "Widening Path",
    "Deeper Waters", "Refiner's Fire", "Mountain Climb", "Radiant Crown",
    "Quiet Trust", "Open Doors", "Living Water", "New Mercies",
]


@dataclass
class LevelConfig:
    mode: str
    index: int
    name: str
    rows: int
    cols: int
    colors: int
    moves: int
    objective: str
    target: int
    collect: Optional[list[dict]] = None
    veil: Optional[dict] = None
    difficulty_rating: float = 0.0
    calibration: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "mode": self.mode,
            "index": self.index,
            "name": self.name,
            "rows": self.rows,
            "cols": self.cols,
            "colors": self.colors,
            "moves": self.moves,
            "objective": self.objective,
            "target": self.target,
            "collect": self.collect,
            "veil": self.veil,
            "difficultyRating": self.difficulty_rating,
            "calibration": self.calibration,
        }


def _objective_for_mode(mode: str) -> str:
    return {"grace-path": "score", "harvest": "collect", "refiners-fire": "veil", "daily-blessing": "score"}.get(
        mode, "score"
    )


def _difficulty_rating(shape: dict) -> float:
    """0..1 relative difficulty, exposed to the client for a difficulty badge
    most match-3 games never bother to show — small transparency win."""
    board_factor = (shape["rows"] * shape["cols"]) / (9 * 9)
    color_factor = shape["colors"] / SYMBOL_COUNT
    move_factor = 1 - min(1.0, shape["moves"] / 24)
    return round(min(1.0, 0.35 * board_factor + 0.30 * color_factor + 0.35 * move_factor), 3)


def _place_veils(rng: random.Random, rows: int, cols: int, density: float,
                 exclude=()) -> list[list[int]]:
    """`exclude` keeps a finale's extra veils off cells the base field already
    veiled. Without it the two lists could name the same cell twice, and the
    level then counted more veils than the board actually holds — which, now
    that a veil goal is a count of veils to free, is the difference between a
    hard level and an unwinnable one."""
    if density <= 0:
        return []
    cells = [(r, c) for r in range(rows) for c in range(cols)]
    rng.shuffle(cells)
    n = round(len(cells) * density)
    if exclude:
        cells = [rc for rc in cells if rc not in exclude]
    chosen = cells[:n]
    return [[r, c, 1 if density < 0.14 else 2] for r, c in chosen]


def _collect_targets(rng: random.Random, shape: dict, ease: float) -> list[dict]:
    """Two symbols to gather, at a count read off _collect_ladder() for this
    board rather than off the level index. The old formula was
    `14 + min(24, index // 3)`, which climbed to ~38 and stayed there while
    the move budget fell to 10 and the palette widened to 8 symbols — by
    level 300 it asked for 40 of a symbol a player gathers 6 of. The jitter
    is kept, at +/-1, so two levels on the same board still differ; it can no
    longer push a goal out of reach."""
    colors = shape["colors"]
    kinds = rng.sample(range(colors), k=min(2, colors))
    jitter = [rng.randint(-1, 1) for _ in kinds]
    return _collect_counts(shape, ease, kinds, jitter), kinds, jitter


def _collect_counts(shape: dict, ease: float, kinds: list, jitter: list) -> list[dict]:
    """The requirement list for a board, read off _collect_ladder(). Split out
    from _collect_targets() so a finale can recalibrate on the board it
    actually ships (see get_level) without re-drawing which symbols are
    chased or how they were jittered."""
    ladder = _collect_ladder(shape["rows"], shape["cols"], shape["colors"], shape["moves"])
    goal = _goal_from_ladder(ladder, _goal_win_rate(ease))
    step = round(goal * GOAL_JITTER)
    return [
        {"type": k, "count": max(COLLECT_MIN_GOAL, goal + j * step)}
        for k, j in zip(kinds, jitter)
    ]


def _veil_required(shape: dict, cells: list, ease: float) -> int:
    """How many of the placed veils must be freed to win, read off
    _veil_ladder() for this board and this many veils.

    Refiner's Fire used to require freeing *every* veil on the board. Against
    the simulator that is not a hard goal, it is an impossible one past the
    early chapters: on a 9x9 board with 8 symbols and a 10-move budget, a
    simulated player clears all the veils in under a third of playouts with
    only *two* on the board, because each one needs two matches landed right
    beside it. No veil count fixes that, so the win condition is now a
    calibrated threshold, the same shape as the score target and the collect
    goal ("free 8 of 14"), and the board keeps the dense veil field the mode
    is built around.

    """
    if not cells:
        return 0
    ladder = _veil_ladder(shape["rows"], shape["cols"], shape["colors"],
                          shape["moves"], tuple(tuple(cell) for cell in cells))
    goal = _goal_from_ladder(ladder, _goal_win_rate(ease))
    return max(1, min(len(cells), max(VEIL_MIN_REQUIRED, goal)))


def _finale_modifiers(mode: str, chapter: int, slot: int) -> dict:
    """slot is 0/1/2 for levels 13/14/15 of the chapter."""
    rng = random.Random(_seed(f"finale::{mode}::{chapter}", slot))
    return {
        "piece": rng.choice(FINALE_PIECES),
        "task": rng.choice(FINALE_TASKS),
        "skin": rng.choice(FINALE_SKINS),
        "constraint": rng.choice(FINALE_CONSTRAINTS),
    }


def _apply_finale(data: dict, shape: dict, mods: dict, rng: random.Random, objective: str) -> None:
    """Mutates a level dict in place with a finale's modifier axes. Reuses
    existing mechanics (veils, bonus multiplier, timed countdown) rather than
    inventing new match rules, so the core engine doesn't have to change.

    The two veil-adding axes (lockedChain, hazardTile) are gated to
    objective=='veil' (Refiner's Fire) only — they used to fire on *any*
    mode's finale. A Grace Path/Harvest/Daily Blessing finale would then
    get veiled tiles dropped onto its board with no veil-progress UI (that
    only renders for the 'veil' objective) and no explanation, so a player
    would just hit unexplained "that one is still veiled" rejections on
    random tiles — a real, reported bug, not a design choice. Every other
    mode substitutes an equally-punchy, mode-agnostic axis instead of
    silently doing nothing on that finale slot."""
    data["finalePiece"] = mods["piece"]
    data["skin"] = mods["skin"]
    data["finale"] = True

    piece = mods["piece"]
    if piece == "lockedChain" and objective != "veil":
        piece = "doublePoints"
    if piece == "lockedChain":
        existing = data["veil"]["cells"] if data.get("veil") else []
        extra = _place_veils(rng, shape["rows"], shape["cols"], 0.10,
                             exclude={(c[0], c[1]) for c in existing})
        data["veil"] = dict(data.get("veil") or {}, cells=existing + extra)
    elif piece == "doublePoints":
        data["bonusMultiplier"] = 2.0
    elif piece == "shrinking":
        cells = [(r, c) for r in range(shape["rows"]) for c in range(shape["cols"])]
        rng.shuffle(cells)
        data["shrinkCells"] = [list(rc) for rc in cells[:4]]

    if mods["task"] == "timed":
        data["timedSeconds"] = 300  # 5:00 countdown; Freeze item pauses it 60s

    constraint = mods["constraint"]
    if constraint == "hazardTile" and objective != "veil":
        constraint = "moreColors"
    if constraint == "tighterMoves":
        data["moves"] = max(MIN_MOVES_FLOOR, round(data["moves"] * 0.85))
    elif constraint == "hazardTile":
        existing = data["veil"]["cells"] if data.get("veil") else []
        extra = _place_veils(rng, shape["rows"], shape["cols"], 0.08,
                             exclude={(c[0], c[1]) for c in existing})
        data["veil"] = dict(data.get("veil") or {}, cells=existing + extra)
    elif constraint == "raisedTarget":
        data["target"] = round(data["target"] * 1.4)
    elif constraint == "moreColors":
        data["colors"] = min(SYMBOL_COUNT, data["colors"] + 1)
    # "noEasing" is intentionally a no-op marker here — the harder base
    # target/moves for finales already comes from FINALE_EASE below.


def _chapter_gate(mode: str, chapter: int) -> Optional[dict]:
    """~40% of chapters get a star-gate; position (within the back third)
    and threshold are both seeded, so it's unpredictable but consistent for
    everyone on that chapter. None = no gate this chapter."""
    rng = random.Random(_seed(f"gate::{mode}", chapter))
    if rng.random() > 0.4:
        return None
    position = rng.randint(9, CHAPTER_SIZE - 1)  # 0-indexed, levels 10-15
    max_stars_so_far = position * 3
    threshold = round(max_stars_so_far * rng.uniform(0.55, 0.65))
    return {"position": position, "starsRequired": threshold}


# Finale levels (13-15 of every chapter) run a genuine harder spike relative
# to *their own chapter's* baseline, not a flat global bump — see
# FINALE_EASE_BUMP in the CHAPTER_EASE_TABLE block above and _chapter_ease().
# Kept as a module-level alias (chapter-1 finale value) for any external code
# that still imports FINALE_EASE directly.
FINALE_EASE = min(CHAPTER_EASE_CAP, CHAPTER_EASE_TABLE[1] + FINALE_EASE_BUMP)


@lru_cache(maxsize=4096)
def get_level(mode: str, index: int) -> dict:
    if index < 0:
        index = 0
    rng = random.Random(_seed(mode, index))

    slot_in_chapter = index % CHAPTER_SIZE
    is_finale = slot_in_chapter >= CHAPTER_SIZE - 3
    chapter = index // CHAPTER_SIZE + 1
    ease = _chapter_ease(chapter) + (FINALE_EASE_BUMP if is_finale else 0.0)
    ease = min(CHAPTER_EASE_CAP, ease)
    shape = _ease(_curve_shape(index), ease)

    target, median = _calibrate_target(shape, rng, ease)

    objective = _objective_for_mode(mode)
    name = STORY_NAMES[index % len(STORY_NAMES)]

    cfg = LevelConfig(
        mode=mode,
        index=index,
        name=name,
        rows=shape["rows"],
        cols=shape["cols"],
        colors=shape["colors"],
        moves=shape["moves"],
        objective=objective,
        target=target,
        difficulty_rating=_difficulty_rating(shape),
        calibration={"simPlayouts": SIM_PLAYOUTS, "simMedianScore": median, "difficultyEase": ease},
    )

    collect_kinds: list = []
    collect_jitter: list = []
    if objective == "collect":
        cfg.collect, collect_kinds, collect_jitter = _collect_targets(rng, shape, ease)
        cfg.target = round(target * 0.6)  # score is a secondary bonus goal in collect mode
    elif objective == "veil":
        cells = _place_veils(rng, shape["rows"], shape["cols"], shape["veil_density"])
        cfg.veil = {"cells": cells, "required": _veil_required(shape, cells, ease)}

    data = cfg.as_dict()
    if is_finale:
        chapter = index // CHAPTER_SIZE + 1
        slot = slot_in_chapter - (CHAPTER_SIZE - 3)
        mods = _finale_modifiers(mode, chapter, slot)
        _apply_finale(data, shape, mods, rng, objective)
        # A finale can tighten the move budget, widen the palette and layer on
        # extra veils — all of which move the board out from under a goal
        # calibrated on the base shape. Recalibrate on what the finale
        # actually ships. Without this a "More Colours" Harvest finale asked
        # for a 5-symbol board's goal on a 6-symbol board, which measured at
        # a 5% win rate where the level was aiming for 77%.
        final_shape = {"rows": data["rows"], "cols": data["cols"],
                       "colors": data["colors"], "moves": data["moves"]}
        if objective == "collect" and data.get("collect"):
            data["collect"] = _collect_counts(final_shape, ease, collect_kinds, collect_jitter)
        elif objective == "veil" and data.get("veil"):
            data["veil"]["required"] = _veil_required(
                final_shape, data["veil"]["cells"], ease)
    return data


def get_chapter(mode: str, chapter: int) -> dict:
    chapter = max(1, chapter)
    start = (chapter - 1) * CHAPTER_SIZE
    levels = [get_level(mode, start + i) for i in range(CHAPTER_SIZE)]
    return {"levels": levels, "gate": _chapter_gate(mode, chapter)}


# ---------------------------------------------------------------------------
# Daily Blessing — its own fixed difficulty band, deliberately *not* derived
# from the global tier curve.
#
# get_level() ties board size/colors/moves to a level *index*, and Daily
# used to just feed it a date-hashed index uniformly spread across 0-19999.
# That's the bug: _curve_shape()'s hardest values (9x9 board, 8 colors,
# minimum move ramp) already saturate by index~250, so >98% of possible
# dates rolled max-tier difficulty — confirmed by generating an actual date's
# level: a 9x9/8-color board with an 11-move budget after the old -3 penalty.
# Nobody should have to be at endgame skill to clear today's Daily.
#
# Fix: keep the date-hash for *flavor* only (which name, small jitter on
# colors/moves) and pin the shape itself to a tuned, moderate band —
# reusing the same Monte Carlo calibration every other level gets, so the
# score target is still simulated, not hand-guessed.
# ---------------------------------------------------------------------------

DAILY_EASE = 0.85          # roughly chapters 4-6 friendliness — approachable
                            # any day, not gated by a player's own progress
DAILY_ROWS = DAILY_COLS = 8
DAILY_COLORS_CHOICES = (5, 6, 6, 6, 7)   # weighted toward 6 — the jitter is
DAILY_MOVES_CHOICES = (18, 19, 20, 20, 20, 21, 22)  # flavor, not a difficulty swing


@lru_cache(maxsize=512)
def get_daily_level(date_iso: str) -> dict:
    # hashlib, not Python's built-in hash() — the latter is randomized per
    # process (PYTHONHASHSEED), which would break "every client gets the
    # same daily challenge" across server restarts. Same sha256 pattern
    # _seed() uses for every other level.
    h = hashlib.sha256(f"faithmatch::daily::{date_iso}".encode()).digest()
    seed = int.from_bytes(h[:8], "big") & 0x7FFFFFFFFFFFFFFF
    rng = random.Random(seed)
    shape = {
        "rows": DAILY_ROWS,
        "cols": DAILY_COLS,
        "colors": rng.choice(DAILY_COLORS_CHOICES),
        "moves": rng.choice(DAILY_MOVES_CHOICES),
        "veil_density": 0.0,  # daily-blessing's objective is always 'score'
    }
    shape = _ease(shape, DAILY_EASE)
    target, median = _calibrate_target(shape, rng, DAILY_EASE)
    name = STORY_NAMES[rng.randrange(len(STORY_NAMES))]

    cfg = LevelConfig(
        mode="daily-blessing",
        index=0,  # unused for daily — see js/screens.js, theming is skipped for this mode
        name=name,
        rows=shape["rows"],
        cols=shape["cols"],
        colors=shape["colors"],
        moves=shape["moves"],
        objective="score",
        target=target,
        difficulty_rating=_difficulty_rating(shape),
        calibration={"simPlayouts": SIM_PLAYOUTS, "simMedianScore": median, "difficultyEase": DAILY_EASE},
    )
    return cfg.as_dict()
