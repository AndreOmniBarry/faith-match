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

# ---------------------------------------------------------------------------
# Endless progression — eras
#
# The problem this solves: _curve_shape() saturates. The board reaches 9x9 by
# level ~120, the palette reaches 8 symbols by ~240, the move budget hits its
# floor by ~66 and _chapter_ease() hits CHAPTER_EASE_CAP at chapter 35. Past
# level ~510 every level in the game is the same level: 9x9, 8 symbols, 10
# moves, ease 1.45. Measured on this generator, level 60,000 differs from
# level 525 only in its tile seed, and the score target does not even climb —
# it wobbles between 430 and 580 on simulation noise, so level 12,000
# generated *easier* than level 600. A 100,000-level ceiling over content that
# stops changing at 600 is a ceiling over nothing.
#
# The fix is not a bigger number. Ease is already at the aggressive end (the
# score target is 1.04x a simulated player's median at the cap) and the move
# budget is at MIN_MOVES_FLOOR, so pushing either further makes levels
# unfair rather than interesting — exactly what the product asked not to do.
# What the genre actually does past its own plateau is change *what the level
# is*: new objectives, new board shapes, new blockers, arriving in waves with
# a breather after each peak. So past ENDLESS_START_CHAPTER the generator
# switches from a single monotonic ramp to eras:
#
#   * ease falls to a trough when an era opens and climbs back to the cap
#     across the era, so difficulty is a felt sawtooth instead of a flat line;
#   * the objective is drawn per level from a pool that widens each era, so a
#     deep chapter mixes five kinds of level instead of repeating one;
#   * the board is *shaped* rather than grown — a 9x9 with its middle columns
#     cut out plays nothing like a full 9x9 and still fits a phone;
#   * the palette widens past the 8 symbols the early game uses, with a move
#     bonus that keeps the wider palette fair;
#   * each era has its own relic for the player to collect toward.
#
# Everything here is gated on `_era_position()` returning non-None, which it
# only does from ENDLESS_START_CHAPTER on. Every level below that is generated
# by exactly the code that generated it before, drawing from `rng` in exactly
# the same order — verified level by level against a stored snapshot, because
# a level's score target is what its star thresholds hang off and moving one
# moves a player's stars.
# ---------------------------------------------------------------------------

ENDLESS_START_CHAPTER = 41       # chapter 41 == level 600. Chapters 1-40 are
                                 # untouched; the legacy curve has been flat
                                 # since chapter 35, so this leaves a short
                                 # deliberate plateau before the first era.
ERA_CHAPTERS = 20                # 300 levels per era
ERA_TROUGH_EASE = 1.20           # an era opens around chapter-13 friendliness
ERA_TROUGH_DRIFT = 0.06          # ...and each era's opening is a notch less
                                 # generous than the last one's, approaching
                                 # ERA_TROUGH_CEILING without ever reaching it
                                 # (see _era_ease). A linear drift would close
                                 # the gap for good after a few dozen eras and
                                 # hand the game back the flat plateau this
                                 # whole section exists to remove, just
                                 # further out.
ERA_TROUGH_CEILING = CHAPTER_EASE_CAP - 0.05   # a breather always stays one
ERA_PEAK_EASE = CHAPTER_EASE_CAP # an era's peak is the hardest the game has
                                 # ever been, never harder — past this point
                                 # difficulty comes from mechanics, not from
                                 # squeezing the same board further
ERA_SHAPE_EXP = 0.85             # <1: the climb starts quickly and eases off,
                                 # so an era spends most of itself near peak
ERA_TROUGH_MOVE_BONUS = 8        # moves an era's opening gets back, scaled by
                                 # how far below the peak its ease sits.
                                 # Without this the sawtooth is invisible in
                                 # the move budget: _ease() multiplies the
                                 # curve's 13 moves by (2 - ease), which is
                                 # 10.4 at the trough and 7.2 at the peak, and
                                 # MIN_MOVES_FLOOR rounds both to the same 10.
                                 # A player would feel the breather only in
                                 # the score target, which is half a breather.

ENDLESS_SYMBOL_COUNT = 11        # deep eras widen the palette past the 8 the
                                 # early game uses. js/content.js ships the
                                 # matching symbols; keep the two in step.
ENDLESS_PALETTE_STEPS = ((6, 3), (3, 2), (1, 1))   # (era >= N, extra symbols),
                                                   # checked in this order
ENDLESS_PALETTE_MOVE_BONUS = 2   # extra moves per extra symbol. A wider
                                 # palette means fewer matches on the same
                                 # board; without this the widening reads as
                                 # a flat difficulty spike rather than a
                                 # different puzzle.

MASK_MAX_SHARE = 0.18            # a mask never cuts away more than this share
                                 # of the board
MASK_MIN_FREE_PER_LINE = 3       # ...and never leaves a row or column with
                                 # fewer free cells than a match needs
MASK_COUNTS = (4, 8, 12)         # cells cut, by severity 1/2/3
MASK_MOVE_BONUS_PER_CELLS = 5    # +1 move per this many cells cut away
MASK_SHAPES = ("corners", "ring", "well", "pillars", "hourglass", "lattice")

# Which objectives can appear in an era, beyond the mode's own. A mode keeps
# its identity — its home objective is weighted heavily — but a deep chapter
# should not be fifteen levels of the same task.
ENDLESS_OBJECTIVE_UNLOCKS = ((0, "cascade"), (1, "collect"), (1, "veil"),
                             (2, "timed"), (2, "score"))
ENDLESS_HOME_WEIGHT = 3          # copies of the mode's own objective in the
                                 # draw pool, against one of each unlocked

CASCADE_MIN_DEPTH = 2            # a "chain" is a match that sets off another.
                                 # Measured on the plateau board a simulated
                                 # player (no specials, no Combo Surge, no
                                 # items) lands a median of 2 of these in 10
                                 # moves and a depth-3 chain in 4% of moves,
                                 # so depth 2 is the bar a goal can be built
                                 # on and depth 3 is not.
CASCADE_SIM_PLAYOUTS = 36
CASCADE_MIN_GOAL = 2             # "set off one chain" is not a mission
CASCADE_MOVE_RELIEF = 1.4        # Chain of Grace is a volume objective — a
                                 # chain is something a player sets up over
                                 # several moves, not something a 10-move
                                 # budget leaves room to hunt for. Measured on
                                 # the plateau board the median simulated
                                 # player lands 2 chains in 10 moves and 2.5
                                 # in 14, which is what moves a goal of 2 from
                                 # a coin flip to a level.

TIMED_SECONDS_PER_MOVE = 11      # a timed level's clock, from its move budget.
                                 # This one number is NOT simulation-derived:
                                 # the simulator has no clock, so there is
                                 # nothing to read it off. It is set so an
                                 # unhurried player (~8s a move on a phone)
                                 # finishes with room, and the Freeze and
                                 # Slow-Mo Sand items both already exist to
                                 # rescue a bad run.
TIMED_MOVE_RELIEF = 1.35         # a timed level trades move pressure for clock
                                 # pressure rather than stacking both
TIMED_TARGET_RELIEF = 0.85

ENDLESS_TWIST_POOL = ("doublePoints", "wildcard", "shrinking", "tighterMoves")
ENDLESS_TWIST_MAX = 3
ENDLESS_RAISED_TARGET = 1.15     # the "Raised Target" finale constraint's
                                 # multiplier on a *secondary* bonus bar — the
                                 # score line on a collect, veil or chain
                                 # level, which is not a win condition.
ENDLESS_RAISED_TARGET_SHIFT = 0.15
                                 # ...and how it applies when score IS the win
                                 # condition: as a shift down the win-rate
                                 # quantile, not as a multiplier.
                                 #
                                 # The legacy 1.4x was sized against a target
                                 # that came from a formula. An endless target
                                 # is read off the ladder at the level's own
                                 # win-rate quantile, and a score ladder is
                                 # tight enough around its median that *any*
                                 # multiplier on it is a much bigger move than
                                 # it looks: 1.4x measured at a 7% win rate
                                 # against a 55% aim, and even 1.15x measured
                                 # at 15%. Asking for the score 40% of players
                                 # reach instead of the score 55% reach is the
                                 # same intent expressed in the units the
                                 # target is actually set in, and it cannot
                                 # walk off the top of the distribution.
                                 # Legacy finales keep their 1.4x: it is part
                                 # of levels players have already cleared.

ERA_TITLES = [
    "The Wilderness", "The Highlands", "Deep Waters", "The Citadel",
    "The Orchard", "The Firmament", "The Sanctuary", "The Pilgrimage",
    "The Covenant", "The Dayspring", "The Harvest Moon", "The Everlasting",
]

# One collectible per era, so a player deep in the game is always working
# toward something with a name rather than an ever-larger pile of gems.
ERA_RELICS = [
    ("dawn-shard", "Dawn Shard", "\U0001F506"),
    ("olive-seal", "Olive Seal", "\U0001FAD2"),
    ("still-water", "Still Water", "\U0001F4A7"),
    ("iron-key", "Iron Key", "\U0001F5DD"),
    ("first-fruit", "First Fruit", "\U0001F347"),
    ("star-chart", "Star Chart", "\U0001F5FA"),
    ("oil-lamp", "Oil Lamp", "\U0001FA94"),
    ("pilgrim-staff", "Pilgrim's Staff", "\U0001F9AF"),
    ("stone-tablet", "Stone Tablet", "\U0001F4DC"),
    ("morning-bell", "Morning Bell", "\U0001F514"),
    ("wheat-sheaf", "Wheat Sheaf", "\U0001F33E"),
    ("crown-of-life", "Crown of Life", "\U0001F451"),
]

# 16 x 20 = 320 names per era, drawn per level, against the 12 that used to
# cycle for the whole game — level 600 was called "A Gentle Start" too.
ENDLESS_NAME_FIRST = [
    "Rising", "Quiet", "Golden", "Hidden", "Steadfast", "Boundless",
    "Gentle", "Burning", "Distant", "Faithful", "Radiant", "Unshaken",
    "Whispering", "Endless", "Patient", "Wondrous",
]
ENDLESS_NAME_SECOND = [
    "Ascent", "Crossing", "Vigil", "Harvest", "Threshold", "Beacon",
    "Current", "Garden", "Summit", "Refuge", "Dawn", "Passage",
    "Ember", "Wellspring", "Horizon", "Crown", "Shelter", "Tide",
    "Lantern", "Covenant",
]



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
    era_pos = _era_position(chapter)
    if era_pos is not None:
        # Past ENDLESS_START_CHAPTER the single ramp becomes a sawtooth — see
        # the endless-progression block above for why a flat cap is the thing
        # being fixed here.
        return _era_ease(era_pos[0], era_pos[2])
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


def _resolve_cascades(board, rows, cols, colors, rng, veil=None, collected=None,
                      chains=None) -> int:
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
    if chains is not None:
        # `combo` counted the waves this one swap set off. A "chain" — what
        # the Chain of Grace objective asks for — is a match that knocks
        # something else down into a further match, i.e. two waves or more.
        chains.append(combo)
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


BLOCKED_LAYERS = 1 << 20   # a blocked cell is a veil nothing can ever crack.
                           # The simulator already treats a veiled cell as a
                           # fixed obstacle that stops matches and stops the
                           # collapse — exactly what a cell cut out of the
                           # board does — so a shaped board reuses that rather
                           # than adding a second obstacle system to keep in
                           # step with it.


def _simulate_playout(rows, cols, colors, moves, rng, objective="score",
                      wanted=frozenset(), veil_cells=None, blocked=()) -> tuple:
    """One playout. Returns
    (score, collected_by_type, veils_left, veils_total, chains).

    `chains` is the per-move cascade depth: 1 for a match that resolved on its
    own, 2+ for one that knocked something down into a further match. That is
    what the Chain of Grace objective counts.

    `blocked` is the level's board mask — cells cut out of a shaped board.
    They are obstacles for every purpose (no match crosses them, nothing falls
    through them) but they are not veils: they are never counted in
    veils_total and never cracked, so a veil goal on a shaped board still
    counts only the veils the level actually placed.

    Called with its default arguments this is the score-only playout the score
    targets have always been calibrated with — move for move and random draw
    for random draw. The collect/veil/mask instrumentation only adds counters
    and obstacle rules; it never changes how a plain board plays."""
    board = _gen_board(rng, rows, cols, colors)
    veil = None
    veils_total = 0
    if veil_cells or blocked:
        veil = [[0] * cols for _ in range(rows)]
    if veil_cells:
        for cell in veil_cells:
            r, c, layers = cell[0], cell[1], cell[2]
            if r < rows and c < cols:
                veil[r][c] = layers
                veils_total += 1
    for r, c in blocked:
        if r < rows and c < cols and veil[r][c] == 0:
            veil[r][c] = BLOCKED_LAYERS
    collected = {} if objective == "collect" else None
    chains: list = []
    score = 0
    blocked_set = set(blocked)
    for _ in range(moves):
        if not _has_move(board, rows, cols, veil):
            # A reshuffle only ever redeals the cells in play. Veiled cells
            # keep their piece (the player has to free them), and a blocked
            # cell has no piece to redeal.
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
        score += _resolve_cascades(board, rows, cols, colors, rng, veil, collected, chains)
    veils_left = 0
    if veil is not None:
        veils_left = sum(1 for r in range(rows) for c in range(cols)
                         if veil[r][c] > 0 and (r, c) not in blocked_set)
    return score, (collected or {}), veils_left, veils_total, chains


def _calibrate_target(shape: dict, rng: random.Random, ease: float,
                      blocked=()) -> tuple[int, int]:
    """Runs SIM_PLAYOUTS simulated playouts and returns (target, median_sim_score).

    `blocked` is the level's board mask, so a shaped board's target is read off
    playouts of that shape rather than of the full rectangle it was cut from —
    a mask removes cells, which removes matches, which lowers what a player
    scores. Defaulted to no mask, which is byte-for-byte the calibration every
    level before the endless range has always had."""
    scores = sorted(
        _simulate_playout(shape["rows"], shape["cols"], shape["colors"], shape["moves"],
                          rng, blocked=blocked)[0]
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


def _goal_from_ladder(ladder: tuple, win_rate: float,
                      safety: Optional[float] = None) -> int:
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
    step = max(1, round((GOAL_SAFETY_SAMPLES if safety is None else safety) / math.sqrt(n)))
    idx = int(n * (1.0 - win_rate)) - step
    return ladder[min(n - 1, max(0, idx))]


@lru_cache(maxsize=1024)
def _probe_collect_ladder(rows: int, cols: int, colors: int, moves: int,
                          mask: tuple = ()) -> tuple:
    """Per-playout count of the *scarcer* of the two chased symbols, sorted
    ascending. The scarcer one is what decides the level: a collect win needs
    every requirement met, so calibrating on the weaker of the two is what
    makes the pair jointly reachable rather than each one separately.

    `mask` is the shaped board's blocked cells. It is part of the cache key
    and part of the probe's seed: the same 9x9 with its middle columns cut out
    is a different board to gather symbols on, and asking the full rectangle's
    goal of it is the same class of mistake the index-based formula made."""
    tag = f"collect-ladder::{rows}x{cols}::{colors}c"
    if mask:
        tag += f"::mask{len(mask)}:{mask[0]}"
    rng = random.Random(_seed(tag, moves))
    wanted = (0, 1) if colors >= 2 else (0,)
    out = []
    for _ in range(GOAL_SIM_PLAYOUTS):
        _, collected, _, _, _ = _simulate_playout(rows, cols, colors, moves, rng,
                                                  objective="collect", wanted=wanted,
                                                  blocked=mask)
        out.append(min(collected.get(k, 0) for k in wanted))
    return tuple(sorted(out))


def _veil_ladder(rows: int, cols: int, colors: int, moves: int, cells: tuple,
                 mask: tuple = ()) -> tuple:
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
        _, _, left, total, _ = _simulate_playout(rows, cols, colors, moves, rng,
                                                 objective="veil", veil_cells=placed,
                                                 blocked=mask)
        out.append(total - left)
    return tuple(sorted(out))


def _collect_ladder(rows: int, cols: int, colors: int, moves: int,
                    mask: tuple = ()) -> tuple:
    """Prebuilt ladder for this board if we have one, else probe it now.

    The probes are deterministic, so their results are checked in as
    goal_tables.py (built by server/tools/gen_goal_tables.py) rather than
    re-derived on every cold start — a serverless instance starts with an
    empty lru_cache, and the client gives up on a chapter after 1.5s. The
    table covers every shape _curve_shape() produces, so the probe below is
    the safety net for a curve change that outruns a table rebuild, not the
    normal path."""
    if mask:
        cached = goal_tables.MASKED_COLLECT_LADDERS.get(
            (rows, cols, colors, moves, mask))
    else:
        cached = goal_tables.COLLECT_LADDERS.get((rows, cols, colors, moves))
    if cached is not None:
        return cached
    return _probe_collect_ladder(rows, cols, colors, moves, mask)

# ---------------------------------------------------------------------------
# Endless progression — era placement, shaped boards, objective rotation
# ---------------------------------------------------------------------------


def _hash32(text: str) -> int:
    """The 32-bit string hash js/content.js uses (hashSeed there), bit for bit.

    The offline fallback cannot reproduce this module's draws: it seeds a
    mulberry32 from a hash where this seeds Python's Mersenne Twister from a
    sha256, and no amount of care makes two different generators emit the same
    stream. That was tolerable while the only things drawn offline were a veil
    layout and which two symbols to gather — a player who dropped offline got
    a different-looking level of the same difficulty.

    It is not tolerable for what an era draws. The objective, the board's
    shape and the level's name are the level's identity: "Collect 3 Crowns"
    becoming "Set off 3 chains" because the request timed out is a different
    level, not a different layout. So those draws go through this hash, which
    both sides can compute exactly, rather than through either generator.
    """
    h = (1779033703 ^ len(text)) & 0xFFFFFFFF
    for ch in text:
        h = (h ^ ord(ch)) & 0xFFFFFFFF
        h = (h * 3432918353) & 0xFFFFFFFF          # Math.imul
        h = ((h << 13) | (h >> 19)) & 0xFFFFFFFF   # (h << 13) | (h >>> 19)
    return h


def _stable_unit(tag: str) -> float:
    """A 0..1 draw both the server and js/content.js compute identically."""
    return _hash32(tag) / 4294967296.0


def _stable_pick(tag: str, options):
    return options[_hash32(tag) % len(options)]


def _era_position(chapter: int):
    """(era_index, slot_in_era, position 0..1) for an endless chapter, else
    None. None is the whole safety guarantee of this module: every caller
    falls back to the pre-existing behaviour on it, so no level below
    ENDLESS_START_CHAPTER can be touched by anything in this section."""
    if chapter < ENDLESS_START_CHAPTER:
        return None
    off = chapter - ENDLESS_START_CHAPTER
    era = off // ERA_CHAPTERS
    slot = off % ERA_CHAPTERS
    t = slot / (ERA_CHAPTERS - 1) if ERA_CHAPTERS > 1 else 1.0
    return era, slot, t


def _era_ease(era: int, t: float) -> float:
    """The sawtooth. An era opens at its trough and climbs to the cap.

    The trough drifts up era by era so the breathers get shorter-lived, but it
    is held below ERA_TROUGH_CEILING forever: if the trough ever reached the
    peak the wave would flatten back into the plateau this whole section
    exists to remove, just a few thousand levels further out."""
    span = ERA_TROUGH_CEILING - ERA_TROUGH_EASE
    trough = ERA_TROUGH_CEILING - span * math.exp(-ERA_TROUGH_DRIFT * era)
    return round(trough + (ERA_PEAK_EASE - trough) * (t ** ERA_SHAPE_EXP), 4)


def _mask_candidates(shape_id: str, rows: int, cols: int) -> list:
    """Cells a shape cuts away, grouped by symmetry and ordered most
    characteristic of the shape first, so a severity is just how many groups
    down this list to read. Deterministic in (shape_id, rows, cols), which is
    what lets a shaped board's goal ladder be prebuilt rather than probed on
    a cold request."""
    mid_r, mid_c = (rows - 1) / 2.0, (cols - 1) / 2.0

    def orbit(r, c):
        """The cell's symmetry group under the board's four reflections.

        Cells sharing an orbit sort together, so a severity that stops
        part-way down the list stops on a whole symmetric group rather than
        half of one. Without it a mask cut to 8 cells took three cells out of
        one corner and two out of another, which reads as a rendering fault
        rather than a shape."""
        a, b = round(abs(r - mid_r), 3), round(abs(c - mid_c), 3)
        return (min(a, b), max(a, b))

    cells = []
    if shape_id == "corners":
        # Bite the four corners: the board becomes an octagon, and the long
        # edge runs that corners make easy stop existing.
        for r in range(rows):
            for c in range(cols):
                d = min(r + c, r + (cols - 1 - c),
                        (rows - 1 - r) + c, (rows - 1 - r) + (cols - 1 - c))
                cells.append((d, r, c))
    elif shape_id == "ring":
        # A ring around the centre, which splits the board into an inner
        # pocket and an outer band that only meet at the ring's gaps.
        for r in range(rows):
            for c in range(cols):
                cheb = max(abs(r - mid_r), abs(c - mid_c))
                cells.append((abs(cheb - 2.0), r, c))
    elif shape_id == "well":
        # A hole in the middle. Everything has to be worked around it.
        for r in range(rows):
            for c in range(cols):
                cells.append((abs(r - mid_r) + abs(c - mid_c), r, c))
    elif shape_id == "pillars":
        # Short vertical bars in alternating columns — the strongest shape
        # here, because a bar cuts its column into two independent wells that
        # never feed each other.
        for r in range(rows):
            for c in range(cols):
                if c in (0, cols - 1) or (c - cols // 2) % 3 != 0:
                    continue
                cells.append((abs(r - mid_r), r, c))
    elif shape_id == "hourglass":
        # Pinch the waist: the top and bottom halves meet through a narrow
        # middle, so a cascade has to funnel.
        for r in range(rows):
            for c in range(cols):
                waist = abs(r - mid_r) < 1.2
                if not waist:
                    continue
                cells.append((-abs(c - mid_c), r, c))
    elif shape_id == "lattice":
        # A sparse scatter on a diagonal lattice. Cuts away the fewest cells
        # of any shape but touches the most columns, so every column ends up
        # segmented.
        for r in range(rows):
            for c in range(cols):
                if (r + 2 * c) % 5 != 0 or r == 0 or r == rows - 1:
                    continue
                cells.append((abs(r - mid_r) + abs(c - mid_c), r, c))
    cells.sort(key=lambda x: (x[0], orbit(x[1], x[2]), x[1], x[2]))
    # Grouped by symmetry orbit, not flat: a severity picks whole groups, so a
    # cut always lands on a complete shape. Slicing a flat list left masks
    # like a 12-cell "well" that was a 13-cell diamond with one cell missing.
    groups: list = []
    last_key = None
    for primary, r, c in cells:
        key = (primary, orbit(r, c))
        if key != last_key:
            groups.append([])
            last_key = key
        groups[-1].append((r, c))
    return groups


def _mask_trim(cells: list, rows: int, cols: int) -> tuple:
    """Drop cells from the end until the board is still playable everywhere:
    no row or column may be left with fewer than MASK_MIN_FREE_PER_LINE free
    cells, because a line shorter than a match cannot produce one, and a
    column of them cannot refill. Trimming from the end preserves the shape's
    character — the first cells in the list are the ones that make it read as
    a ring or an hourglass."""
    kept = list(cells)
    while kept:
        row_free = [cols] * rows
        col_free = [rows] * cols
        for r, c in kept:
            row_free[r] -= 1
            col_free[c] -= 1
        if min(row_free) >= MASK_MIN_FREE_PER_LINE and min(col_free) >= MASK_MIN_FREE_PER_LINE:
            break
        kept.pop()
    return tuple(sorted(kept))


@lru_cache(maxsize=256)
def _board_mask(shape_id: str, rows: int, cols: int, severity: int) -> tuple:
    """The blocked cells of a shaped board, as a sorted tuple."""
    if shape_id == "none" or severity <= 0:
        return ()
    want = MASK_COUNTS[min(severity, len(MASK_COUNTS)) - 1]
    max_cells = int(rows * cols * MASK_MAX_SHARE)
    want = min(want, max_cells)
    chosen: list = []
    for group in _mask_candidates(shape_id, rows, cols):
        if chosen and (len(chosen) >= want or len(chosen) + len(group) > max_cells):
            break
        chosen.extend(group)
    return _mask_trim(chosen, rows, cols)


def _endless_mask(mode: str, index: int, era: int, t: float,
                  rows: int, cols: int) -> tuple:
    """Which shape, if any, this level's board is cut to.

    Masks stay rare through the first era and become the norm later, so the
    first thing a player meets past the plateau is a familiar board with an
    unfamiliar objective rather than everything changing at once."""
    chance = min(0.75, 0.15 + 0.12 * era + 0.25 * t)
    if _stable_unit(f"mask::{mode}::{index}") > chance:
        return "none", 0, ()
    shape_id = _stable_pick(f"mask-shape::{mode}::{index}", MASK_SHAPES)
    severity = 1 + min(len(MASK_COUNTS) - 1, int((era + t * 2) / 2.2))
    return shape_id, severity, _board_mask(shape_id, rows, cols, severity)


def _endless_palette(era: int) -> int:
    """Extra symbols beyond SYMBOL_COUNT for this era."""
    for need, extra in ENDLESS_PALETTE_STEPS:
        if era >= need:
            return extra
    return 0


def _endless_objective(mode: str, index: int, era: int) -> str:
    """The level's task. The mode's own objective keeps ENDLESS_HOME_WEIGHT
    copies in the pool against one of each unlocked alternative, so Harvest
    still reads as Harvest while a Harvest chapter stops being fifteen
    identical gathering levels."""
    home = _objective_for_mode(mode)
    if mode == "daily-blessing":
        return home
    pool = [home] * ENDLESS_HOME_WEIGHT
    for need, obj in ENDLESS_OBJECTIVE_UNLOCKS:
        if era >= need and obj != home:
            pool.append(obj)
    return _stable_pick(f"objective::{mode}::{index}", pool)


def _endless_name(mode: str, index: int) -> str:
    first = _stable_pick(f"name-a::{mode}::{index}", ENDLESS_NAME_FIRST)
    second = _stable_pick(f"name-b::{mode}::{index}", ENDLESS_NAME_SECOND)
    return f"{first} {second}"


def _era_relic(era: int) -> dict:
    relic_id, name, emoji = ERA_RELICS[era % len(ERA_RELICS)]
    # Past the first pass through the table an era's relic is the same object
    # a later age of it — "Dawn Shard II" — rather than a name collision.
    cycle = era // len(ERA_RELICS)
    if cycle:
        suffix = " " + "I" * (cycle + 1) if cycle < 3 else f" {cycle + 1}"
        relic_id = f"{relic_id}-{cycle + 1}"
        name += suffix
    return {"id": relic_id, "name": name, "emoji": emoji}


def _era_title(era: int) -> str:
    title = ERA_TITLES[era % len(ERA_TITLES)]
    cycle = era // len(ERA_TITLES)
    return title if not cycle else f"{title} {cycle + 1}"


def _endless_twists(mode: str, index: int, era: int, t: float) -> list:
    """Extra modifiers on an ordinary endless level.

    These are drawn from the finale axes that are safe on any objective —
    nothing here adds veils, because veil progress only renders for the veil
    objective and a player on a Grace Path level would just meet unexplained
    "that one is still veiled" rejections (the bug _apply_finale documents).
    The budget grows with the era and with position inside it, so the back
    half of a late era is genuinely busier than the front of an early one."""
    budget = min(ENDLESS_TWIST_MAX, int(era / 2.0) + (1 if t > 0.45 else 0))
    if budget <= 0:
        return []
    n = int(_stable_unit(f"twist-n::{mode}::{index}") * (budget + 1))
    n = min(n, budget, len(ENDLESS_TWIST_POOL))
    # Picked by rotating the pool rather than by sampling it, so the same n
    # gives the same set on both sides without either having to reproduce the
    # other's shuffle.
    start = _hash32(f"twist::{mode}::{index}") % len(ENDLESS_TWIST_POOL)
    return [ENDLESS_TWIST_POOL[(start + i) % len(ENDLESS_TWIST_POOL)] for i in range(n)]


@lru_cache(maxsize=1024)
def _cascade_ladder(rows: int, cols: int, colors: int, moves: int,
                    mask: tuple = ()) -> tuple:
    """Per-playout count of moves that set off a chain of CASCADE_MIN_DEPTH
    waves or more, sorted ascending. Same shape of measurement as the collect
    ladder, and the same caveat: the simulator plays no specials and no Combo
    Surge, both of which cause far bigger cascades than a bare swap, so a real
    player's count sits well above this."""
    tag = f"cascade-ladder::{rows}x{cols}::{colors}c"  # see _probe_collect_ladder
    if mask:
        tag += f"::mask{len(mask)}:{mask[0]}"
    rng = random.Random(_seed(tag, moves))
    out = []
    for _ in range(CASCADE_SIM_PLAYOUTS):
        _, _, _, _, chains = _simulate_playout(rows, cols, colors, moves, rng,
                                               blocked=mask)
        out.append(sum(1 for d in chains if d >= CASCADE_MIN_DEPTH))
    return tuple(sorted(out))


SCORE_SIM_PLAYOUTS = 36          # see _score_ladder
SCORE_JITTER = 0.04              # +/- this share of the target, drawn from the
                                 # level's own rng, so two levels on the same
                                 # board still differ without the difference
                                 # being sampling noise
SCORE_MIN_TARGET = 200
SCORE_SAFETY_SAMPLES = 18.0      # three times GOAL_SAFETY_SAMPLES, because a
                                 # score ladder is a different kind of
                                 # distribution. A collect goal is an integer
                                 # in the single digits, so one step down the
                                 # ladder is a whole piece of slack; a score
                                 # ladder spreads hundreds of points over its
                                 # 36 samples, and one step is a rounding
                                 # error against the noise between the ladder
                                 # and a real run. Measured over 1,215 swept
                                 # levels, one step left three of them
                                 # clearing at 13-20% against a 55-60% aim.


@lru_cache(maxsize=1024)
def _probe_score_ladder(rows: int, cols: int, colors: int, moves: int,
                        mask: tuple = ()) -> tuple:
    """Per-playout score, sorted ascending, for one board.

    Endless score targets are read off this at the level's win-rate quantile,
    the same way collect, veil and chain goals are, instead of from
    _calibrate_target()'s `0.72 * ease * median`. Two reasons.

    The formula is not a win rate. At CHAPTER_EASE_CAP it works out to 1.04x
    the median a simulated player scores, so by construction rather more than
    half of them fall short — measured on the levels just before the endless
    range, a simulated average player clears level 550 in 27% of playouts and
    level 599 in 13%, against the 55% the same level's collect goal would aim
    for. Reading the target off the ladder makes the aim and the measurement
    the same number.

    And the formula is noisy. It takes the median of SIM_PLAYOUTS = 18
    playouts drawn from the level's own seed, so two levels on an identical
    board get targets up to 20% apart on sampling noise alone — which at the
    old plateau was the *only* thing distinguishing one level from the next.
    A per-board ladder, prebuilt into goal_tables.py, replaces that noise with
    a deliberate SCORE_JITTER.

    Levels before ENDLESS_START_CHAPTER keep the old formula untouched: their
    targets are what their star thresholds hang off, so a fairer number is
    still a moved number, and moving one moves a player's stars."""
    tag = f"score-ladder::{rows}x{cols}::{colors}c"
    if mask:
        tag += f"::mask{len(mask)}:{mask[0]}"
    rng = random.Random(_seed(tag, moves))
    out = [_simulate_playout(rows, cols, colors, moves, rng, blocked=mask)[0]
           for _ in range(SCORE_SIM_PLAYOUTS)]
    return tuple(sorted(out))


def _score_ladder(rows: int, cols: int, colors: int, moves: int,
                  mask: tuple = ()) -> tuple:
    cached = goal_tables.SCORE_LADDERS.get((rows, cols, colors, moves, mask))
    return cached if cached is not None else _probe_score_ladder(
        rows, cols, colors, moves, mask)


def _endless_target(shape: dict, ease: float, mask: tuple, jitter: float,
                    win_rate_shift: float = 0.0) -> tuple:
    """(target, median) for an endless score or timed level.

    `win_rate_shift` lowers the share of simulated players the target is set
    to be reachable by — how a "Raised Target" finale raises the bar here."""
    ladder = _score_ladder(shape["rows"], shape["cols"], shape["colors"],
                           shape["moves"], mask)
    win_rate = max(0.2, _goal_win_rate(ease) - win_rate_shift)
    raw = _goal_from_ladder(ladder, win_rate,
                            SCORE_SAFETY_SAMPLES) * (1.0 + jitter)
    median = ladder[len(ladder) // 2]
    return max(SCORE_MIN_TARGET, round(raw / 10) * 10), median


def _floor_the_board_supports(ladder: tuple, floor: int) -> int:
    """`floor` if the board can actually give it, else 1.

    A minimum goal is there to stop a level asking for something trivial, and
    on nearly every board it costs nothing. On the hostile end of the endless
    range it costs everything: measured on a 9x9 with 11 symbols and 12 cells
    cut out, a simulated player sets off a median of *zero* chain reactions
    even with 21 moves, because a wide palette makes incidental matches rare
    and cut cells stop falling pieces from landing into new ones. Asking two
    of that board is not a hard level, it is an impossible one — the exact
    failure the whole calibration module exists to prevent, arriving through
    the floor rather than through the goal."""
    if not ladder:
        return 1
    return floor if ladder[len(ladder) // 2] >= floor else 1


def _cascade_goal(shape: dict, ease: float, mask: tuple) -> int:
    key = (shape["rows"], shape["cols"], shape["colors"], shape["moves"], mask)
    ladder = goal_tables.CASCADE_LADDERS.get(key)
    if ladder is None:
        ladder = _cascade_ladder(*key)
    goal = _goal_from_ladder(ladder, _goal_win_rate(ease))
    return max(_floor_the_board_supports(ladder, CASCADE_MIN_GOAL), goal)


def _endless_shape(shape: dict, mode: str, index: int, era: int, t: float,
                   objective: str, ease: float) -> tuple:
    """The board an endless level actually ships, and the cells cut out of it.

    Three things change here and each one pays for itself in moves, because a
    wider palette and a smaller board both mean fewer matches and neither is
    meant to read as "the same level with less air":

      * the palette widens past the 8 symbols the early game uses, which is
        the one axis _curve_shape() maxes out that can genuinely keep going;
      * the board is cut to a shape, which changes how pieces fall rather than
        how many there are;
      * a timed level trades some of the clock's pressure back for moves,
        rather than stacking a countdown on top of an already-tight budget,
        and a Chain of Grace level gets room to actually build a chain.

    On top of those, the era's own breather is paid in moves as well as in the
    score target — see ERA_TROUGH_MOVE_BONUS for why the ease curve alone
    cannot deliver it.
    """
    out = dict(shape)
    out["moves"] += round((ERA_PEAK_EASE - ease) * ERA_TROUGH_MOVE_BONUS)
    extra = _endless_palette(era)
    if extra:
        out["colors"] = min(ENDLESS_SYMBOL_COUNT, out["colors"] + extra)
        out["moves"] += (out["colors"] - shape["colors"]) * ENDLESS_PALETTE_MOVE_BONUS
    mask_id, severity, mask = _endless_mask(mode, index, era, t,
                                            out["rows"], out["cols"])
    if mask:
        out["moves"] += round(len(mask) / MASK_MOVE_BONUS_PER_CELLS)
    if objective == "timed":
        out["moves"] = max(MIN_MOVES_FLOOR, round(out["moves"] * TIMED_MOVE_RELIEF))
    elif objective == "cascade":
        out["moves"] = max(MIN_MOVES_FLOOR, round(out["moves"] * CASCADE_MOVE_RELIEF))
    return out, mask, mask_id, severity


def _apply_twists(data: dict, shape: dict, twists: list, mask: tuple,
                  rng: random.Random) -> None:
    """Layer an endless level's modifiers onto its dict, in place.

    Deliberately reuses the finale axes rather than inventing parallel ones,
    and deliberately leaves out the two that add veils: veil progress only
    renders for the veil objective, so veils on any other level read to a
    player as unexplained "that one is still veiled" rejections — the bug
    _apply_finale() documents. `shrinking` is the exception and is safe,
    because it announces itself with a toast when it fires."""
    for twist in twists:
        if twist == "doublePoints":
            data["bonusMultiplier"] = 2.0
        elif twist == "wildcard":
            data["finalePiece"] = "wildcard"
        elif twist == "shrinking":
            blocked = set(mask)
            cells = [(r, c) for r in range(shape["rows"]) for c in range(shape["cols"])
                     if (r, c) not in blocked]
            rng.shuffle(cells)
            data["shrinkCells"] = [list(rc) for rc in cells[:4]]
        elif twist == "tighterMoves":
            data["moves"] = max(MIN_MOVES_FLOOR, round(data["moves"] * 0.85))
    if twists:
        data["twists"] = list(twists)


def _fit_goal(data: dict, objective: str, ease: float, mask: tuple,
              collect_kinds: list, collect_jitter: list,
              score_jitter: Optional[float] = None) -> None:
    """Re-read the level's goal off the board it actually ships.

    A finale or an endless twist can tighten the move budget and widen the
    palette after the goal was calibrated, which moves the board out from
    under it — the mistake that made a "More Colours" Harvest finale ask a
    5-symbol board's goal of a 6-symbol board, measured at a 5% win rate on a
    level aiming for 77%."""
    final_shape = {"rows": data["rows"], "cols": data["cols"],
                   "colors": data["colors"], "moves": data["moves"]}
    if objective == "collect" and data.get("collect"):
        data["collect"] = _collect_counts(final_shape, ease, collect_kinds,
                                          collect_jitter, mask)
    elif objective == "veil" and data.get("veil"):
        data["veil"]["required"] = _veil_required(final_shape, data["veil"]["cells"],
                                                  ease, mask)
    elif objective == "cascade" and data.get("cascade"):
        data["cascade"]["required"] = _cascade_goal(final_shape, ease, mask)
    elif objective in ("score", "timed") and score_jitter is not None:
        # The score target needs refitting for exactly the same reason the
        # others do, and it was the one goal nobody was refitting: a
        # "tighter moves" twist cuts the budget 15% after the target was set,
        # which measured a 9x9/11-symbol level at a 0% simulated win rate
        # against a 56% aim. Only endless levels are refitted — a level below
        # the endless range keeps the target its stars hang off.
        shift = ENDLESS_RAISED_TARGET_SHIFT if data.get("raisedTargetBy") else 0.0
        base, _ = _endless_target(final_shape, ease, mask, score_jitter, shift)
        data["target"] = (round(base * TIMED_TARGET_RELIEF / 10) * 10
                          if objective == "timed" else base)


def _timed_seconds(moves: int) -> int:
    """Clock for a timed level, rounded to a readable 5 seconds."""
    return max(60, round(moves * TIMED_SECONDS_PER_MOVE / 5) * 5)


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
    cascade: Optional[dict] = None
    timed_seconds: Optional[int] = None
    mask: Optional[list[list[int]]] = None
    era: Optional[dict] = None
    difficulty_rating: float = 0.0
    calibration: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        data = {
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
        # The endless fields are omitted rather than sent as nulls, so a level
        # outside the endless range serializes byte-for-byte the payload it
        # always has. That is checked level by level against a stored
        # snapshot; see server/tools/verify_legacy_levels.py.
        if self.cascade is not None:
            data["cascade"] = self.cascade
        if self.timed_seconds is not None:
            data["timedSeconds"] = self.timed_seconds
        if self.mask is not None:
            data["mask"] = self.mask
        if self.era is not None:
            data["era"] = self.era
        return data


def _objective_for_mode(mode: str) -> str:
    return {"grace-path": "score", "harvest": "collect", "refiners-fire": "veil", "daily-blessing": "score"}.get(
        mode, "score"
    )


def _difficulty_rating(shape: dict, mask: tuple = ()) -> float:
    """0..1 relative difficulty, exposed to the client for a difficulty badge
    most match-3 games never bother to show — small transparency win.

    A mask counts toward the board factor rather than against it: cutting
    cells out of a board makes it harder to work, not easier, even though it
    leaves fewer of them. Without the term a shaped board read as *easier*
    than the full rectangle it was cut from."""
    cells = shape["rows"] * shape["cols"]
    board_factor = cells / (9 * 9)
    if mask:
        board_factor *= 1 + (len(mask) / cells)
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


def _collect_targets(rng: random.Random, shape: dict, ease: float,
                     mask: tuple = ()) -> list[dict]:
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
    return _collect_counts(shape, ease, kinds, jitter, mask), kinds, jitter


def _collect_counts(shape: dict, ease: float, kinds: list, jitter: list,
                    mask: tuple = ()) -> list[dict]:
    """The requirement list for a board, read off _collect_ladder(). Split out
    from _collect_targets() so a finale can recalibrate on the board it
    actually ships (see get_level) without re-drawing which symbols are
    chased or how they were jittered."""
    ladder = _collect_ladder(shape["rows"], shape["cols"], shape["colors"],
                             shape["moves"], mask)
    goal = _goal_from_ladder(ladder, _goal_win_rate(ease))
    step = round(goal * GOAL_JITTER)
    return [
        {"type": k, "count": max(COLLECT_MIN_GOAL, goal + j * step)}
        for k, j in zip(kinds, jitter)
    ]


def _veil_required(shape: dict, cells: list, ease: float,
                   mask: tuple = ()) -> int:
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
                          shape["moves"], tuple(tuple(cell) for cell in cells),
                          mask)
    goal = _goal_from_ladder(ladder, _goal_win_rate(ease))
    floor = _floor_the_board_supports(ladder, VEIL_MIN_REQUIRED)
    return max(1, min(len(cells), max(floor, goal)))


def _finale_modifiers(mode: str, chapter: int, slot: int,
                      stable: bool = False) -> dict:
    """slot is 0/1/2 for levels 13/14/15 of the chapter.

    `stable` draws through _hash32 instead of this module's rng, so an endless
    finale is the same finale whether it came from here or from the offline
    fallback. It is off below ENDLESS_START_CHAPTER and has to stay off there:
    a finale's modifiers set its move budget, its palette and its target, so
    switching how they are drawn would move the stars of every player who has
    already cleared one. Those finales keep diverging offline, as they always
    have — measured over 1,215 levels, they were the only ones that did."""
    if stable:
        tag = f"finale::{mode}::{chapter}::{slot}"
        return {
            "piece": _stable_pick(f"piece::{tag}", FINALE_PIECES),
            "task": _stable_pick(f"task::{tag}", FINALE_TASKS),
            "skin": _stable_pick(f"skin::{tag}", FINALE_SKINS),
            "constraint": _stable_pick(f"constraint::{tag}", FINALE_CONSTRAINTS),
        }
    rng = random.Random(_seed(f"finale::{mode}::{chapter}", slot))
    return {
        "piece": rng.choice(FINALE_PIECES),
        "task": rng.choice(FINALE_TASKS),
        "skin": rng.choice(FINALE_SKINS),
        "constraint": rng.choice(FINALE_CONSTRAINTS),
    }


def _apply_finale(data: dict, shape: dict, mods: dict, rng: random.Random,
                  objective: str, symbol_cap: int = SYMBOL_COUNT) -> None:
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
        # 5:00 flat below the endless range, where it always has been. Past it
        # the clock follows the move budget like every other timed level, so a
        # 10-move finale and a 22-move one are not both given five minutes.
        data["timedSeconds"] = (_timed_seconds(data["moves"])
                                if symbol_cap > SYMBOL_COUNT else 300)

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
        if symbol_cap > SYMBOL_COUNT:
            data["target"] = round(data["target"] * ENDLESS_RAISED_TARGET)
            # A note for _fit_goal(), which re-reads this level's target off
            # the board the finale ships and would otherwise undo the
            # constraint. get_level() drops it again before the level goes
            # out, so no level's payload grows a field over this.
            data["raisedTargetBy"] = ENDLESS_RAISED_TARGET
        else:
            data["target"] = round(data["target"] * 1.4)

    elif constraint == "moreColors":
        # symbol_cap, not SYMBOL_COUNT: an endless level's palette is already
        # wider than the early game's 8, and min(8, 10 + 1) would *narrow* it.
        data["colors"] = max(data["colors"], min(symbol_cap, data["colors"] + 1))
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


@lru_cache(maxsize=8192)
def _level_plan(mode: str, index: int) -> dict:
    """Everything about a level that is decided *before* any simulation runs:
    its chapter, ease, board, mask, task and modifiers.

    Split out of get_level() so the goal-table builder can enumerate the boards
    a goal will be calibrated on without generating (and therefore simulating)
    every level in the range — 16,000 levels of Monte Carlo to find out which
    boards exist is not a build step anyone will run. Nothing here draws from
    the level's own `rng`, so the split cannot reorder it."""
    slot_in_chapter = index % CHAPTER_SIZE
    is_finale = slot_in_chapter >= CHAPTER_SIZE - 3
    chapter = index // CHAPTER_SIZE + 1
    ease = _chapter_ease(chapter) + (FINALE_EASE_BUMP if is_finale else 0.0)
    ease = min(CHAPTER_EASE_CAP, ease)
    shape = _ease(_curve_shape(index), ease)

    # Past ENDLESS_START_CHAPTER a level's task, board shape and palette are
    # drawn per level instead of being fixed by the mode and the curve. All of
    # it is seeded from its own namespaces, never from the level's `rng`, so
    # `rng` is still consumed in exactly the order it always was and no level
    # below the endless range can move. era_pos is None for all of those
    # levels and every branch here falls back to the original behaviour on it.
    era_pos = _era_position(chapter)
    mask: tuple = ()
    mask_id, mask_severity = "none", 0
    twists: list = []
    era_info = None
    if era_pos is None:
        objective = _objective_for_mode(mode)
        name = STORY_NAMES[index % len(STORY_NAMES)]
    else:
        era, _slot, era_t = era_pos
        objective = _endless_objective(mode, index, era)
        name = _endless_name(mode, index)
        shape, mask, mask_id, mask_severity = _endless_shape(
            shape, mode, index, era, era_t, objective, ease)
        twists = _endless_twists(mode, index, era, era_t)
        era_info = {
            "index": era,
            "title": _era_title(era),
            "position": round(era_t, 3),
            "relic": _era_relic(era),
        }

    return {
        "chapter": chapter, "slot": slot_in_chapter, "is_finale": is_finale,
        "ease": ease, "shape": shape, "mask": mask, "mask_id": mask_id,
        "mask_severity": mask_severity, "objective": objective, "name": name,
        "twists": twists, "era": era_info,
        "symbol_cap": SYMBOL_COUNT if era_info is None else ENDLESS_SYMBOL_COUNT,
    }


@lru_cache(maxsize=4096)
def get_level(mode: str, index: int) -> dict:
    if index < 0:
        index = 0
    rng = random.Random(_seed(mode, index))

    plan = _level_plan(mode, index)
    slot_in_chapter, is_finale = plan["slot"], plan["is_finale"]
    ease, shape, mask = plan["ease"], plan["shape"], plan["mask"]
    mask_id, mask_severity = plan["mask_id"], plan["mask_severity"]
    objective, name, twists, era_info = (plan["objective"], plan["name"],
                                         plan["twists"], plan["era"])

    if era_info is None:
        target, median = _calibrate_target(shape, rng, ease, mask)
    else:
        # Endless levels read their target off a per-board ladder at the same
        # win-rate quantile every other goal uses — see _probe_score_ladder().
        # The jitter draw comes first so it is the same draw whatever the
        # objective turns out to be.
        jitter = rng.uniform(-SCORE_JITTER, SCORE_JITTER)
        target, median = _endless_target(shape, ease, mask, jitter)

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
        difficulty_rating=_difficulty_rating(shape, mask),
        calibration={"simPlayouts": SIM_PLAYOUTS, "simMedianScore": median, "difficultyEase": ease},
    )
    if era_info is not None:
        cfg.era = era_info
        if mask:
            cfg.mask = [list(rc) for rc in mask]
            cfg.calibration["boardShape"] = f"{mask_id}{mask_severity}"

    collect_kinds: list = []
    collect_jitter: list = []
    if objective == "collect":
        cfg.collect, collect_kinds, collect_jitter = _collect_targets(rng, shape, ease, mask)
        cfg.target = round(target * 0.6)  # score is a secondary bonus goal in collect mode
    elif objective == "veil":
        cells = _place_veils(rng, shape["rows"], shape["cols"], shape["veil_density"],
                             exclude=set(mask))
        cfg.veil = {"cells": cells, "required": _veil_required(shape, cells, ease, mask)}
    elif objective == "cascade":
        cfg.cascade = {"required": _cascade_goal(shape, ease, mask)}
        cfg.target = round(target * 0.6)  # score is the secondary goal, as in collect
    elif objective == "timed":
        # A timed level is a score level whose pressure is the clock rather
        # than the move budget, so the target comes down as the countdown
        # goes on. _endless_shape() has already widened the move budget.
        cfg.target = round(target * TIMED_TARGET_RELIEF / 10) * 10
        cfg.timed_seconds = _timed_seconds(shape["moves"])
    # 'score' needs nothing: target is already what the ladder returned.

    data = cfg.as_dict()
    score_jitter = jitter if era_info is not None else None
    if twists:
        _apply_twists(data, shape, twists, mask,
                      random.Random(_seed(f"twist-cells::{mode}", index)))
        _fit_goal(data, objective, ease, mask, collect_kinds, collect_jitter,
                  score_jitter)
    if is_finale:
        chapter = index // CHAPTER_SIZE + 1
        slot = slot_in_chapter - (CHAPTER_SIZE - 3)
        mods = _finale_modifiers(mode, chapter, slot, stable=era_info is not None)
        _apply_finale(data, shape, mods, rng, objective, plan["symbol_cap"])
        # A finale can tighten the move budget, widen the palette and layer on
        # extra veils — all of which move the board out from under a goal
        # calibrated on the base shape. Recalibrate on what the finale
        # actually ships. Without this a "More Colours" Harvest finale asked
        # for a 5-symbol board's goal on a 6-symbol board, which measured at
        # a 5% win rate where the level was aiming for 77%.
        _fit_goal(data, objective, ease, mask, collect_kinds, collect_jitter,
                  score_jitter)
        data.pop("raisedTargetBy", None)
    return data


def goal_shape_keys(mode: str, index: int) -> list:
    """Every (objective, rows, cols, colors, moves, mask) a goal for this level
    could be calibrated on.

    A level's goal is read off the board it actually ships, which after a
    finale's or an endless twist's modifiers is not the board the curve
    produced — a tightened move budget and a widened palette are each a
    different board to gather symbols on. Enumerating the variants here, from
    the generator's own rules rather than from a copy of them in the build
    script, is what keeps a cold request off the live probe path.

    Cheap: this runs no simulation."""
    plan = _level_plan(mode, index)
    objective, shape, mask = plan["objective"], plan["shape"], plan["mask"]
    if objective == "veil":
        # A veil goal depends on the level's individual veil layout, not just
        # on its board, so it cannot be tabled by shape. See _veil_ladder().
        return []
    if objective in ("score", "timed") and plan["era"] is None:
        # A level below the endless range still calibrates its target per
        # level from its own rng, which no shape table can stand in for.
        return []

    moves = {shape["moves"]}
    colors = {shape["colors"]}
    if "tighterMoves" in plan["twists"]:
        moves.add(max(MIN_MOVES_FLOOR, round(shape["moves"] * 0.85)))
    if plan["is_finale"]:
        for m in list(moves):
            moves.add(max(MIN_MOVES_FLOOR, round(m * 0.85)))
        for c in list(colors):
            colors.add(max(c, min(plan["symbol_cap"], c + 1)))
    return [(objective, shape["rows"], shape["cols"], c, m, mask)
            for m in sorted(moves) for c in sorted(colors)]


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
