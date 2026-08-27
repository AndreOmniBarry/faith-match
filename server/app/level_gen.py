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
import random
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Optional

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

# This build's documented content range. Not 1000 hand-authored rows — the
# generator below is already unbounded and deterministic; this is the range
# we're calling "released" for now, per the "scope by 1000 each build" plan.
# Raise by CHAPTER_SIZE*~67 next time; nothing else here needs to change.
CONTENT_CEILING_LEVELS = 1000

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
    veil_density = min(0.22, 0.08 + index * 0.0035)

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
    eased["veil_density"] = round(shape["veil_density"] * ease, 4)
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


def _line_run(board, rows, cols, r, c) -> int:
    t = board[r][c]
    run = 1
    cc = c - 1
    while cc >= 0 and board[r][cc] == t:
        run += 1
        cc -= 1
    cc = c + 1
    while cc < cols and board[r][cc] == t:
        run += 1
        cc += 1
    if run >= 3:
        return run
    run = 1
    rr = r - 1
    while rr >= 0 and board[rr][c] == t:
        run += 1
        rr -= 1
    rr = r + 1
    while rr < rows and board[rr][c] == t:
        run += 1
        rr += 1
    return run if run >= 3 else 1


def _find_runs(board, rows, cols):
    """Returns list of (length, cells[(r,c),...]) for every horizontal/vertical run >=3."""
    runs = []
    for r in range(rows):
        c = 0
        while c < cols:
            t = board[r][c]
            c2 = c + 1
            while c2 < cols and board[r][c2] == t:
                c2 += 1
            if c2 - c >= 3:
                runs.append((c2 - c, [(r, k) for k in range(c, c2)]))
            c = c2
    for c in range(cols):
        r = 0
        while r < rows:
            t = board[r][c]
            r2 = r + 1
            while r2 < rows and board[r2][c] == t:
                r2 += 1
            if r2 - r >= 3:
                runs.append((r2 - r, [(k, c) for k in range(r, r2)]))
            r = r2
    return runs


def _has_move(board, rows, cols) -> bool:
    def swap_run_ok(r1, c1, r2, c2):
        t1, t2 = board[r1][c1], board[r2][c2]
        if t1 == t2:
            return False
        board[r1][c1], board[r2][c2] = t2, t1
        ok = _line_run(board, rows, cols, r1, c1) >= 3 or _line_run(board, rows, cols, r2, c2) >= 3
        board[r1][c1], board[r2][c2] = t1, t2
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


def _collapse_refill(board, rows, cols, colors, rng):
    for c in range(cols):
        write_row = rows - 1
        for r in range(rows - 1, -1, -1):
            if board[r][c] is not None:
                board[write_row][c] = board[r][c]
                if write_row != r:
                    board[r][c] = None
                write_row -= 1
        for r in range(write_row, -1, -1):
            board[r][c] = rng.randrange(colors)


def _resolve_cascades(board, rows, cols, colors, rng) -> int:
    score = 0
    combo = 0
    while True:
        runs = _find_runs(board, rows, cols)
        if not runs:
            break
        matched = set()
        for length, cells in runs:
            score += round(_points_for(length) * (1 + 0.4 * combo))
            matched.update(cells)
        combo += 1
        for r, c in matched:
            board[r][c] = None
        _collapse_refill(board, rows, cols, colors, rng)
    return score


def _pick_swap(board, rows, cols, rng, greedy: bool):
    """Find a valid adjacent swap. Greedy = pick the one producing the longest
    run (an optimal-ish player); non-greedy = pick any valid swap at random
    (an average player). This mix is what makes the simulated median score a
    realistic "typical player" target instead of a best-case one."""
    candidates = []
    for r in range(rows):
        for c in range(cols):
            for dr, dc in ((0, 1), (1, 0)):
                r2, c2 = r + dr, c + dc
                if r2 >= rows or c2 >= cols:
                    continue
                t1, t2 = board[r][c], board[r2][c2]
                if t1 == t2:
                    continue
                board[r][c], board[r2][c2] = t2, t1
                best = max(_line_run(board, rows, cols, r, c), _line_run(board, rows, cols, r2, c2))
                board[r][c], board[r2][c2] = t1, t2
                if best >= 3:
                    candidates.append(((r, c), (r2, c2), best))
    if not candidates:
        return None
    if greedy:
        top = max(c[2] for c in candidates)
        pool = [c for c in candidates if c[2] == top]
        return rng.choice(pool)
    return rng.choice(candidates)


def _simulate_playout(rows, cols, colors, moves, rng) -> int:
    board = _gen_board(rng, rows, cols, colors)
    score = 0
    for _ in range(moves):
        if not _has_move(board, rows, cols):
            flat = [board[r][c] for r in range(rows) for c in range(cols)]
            rng.shuffle(flat)
            for i, (r, c) in enumerate((r, c) for r in range(rows) for c in range(cols)):
                board[r][c] = flat[i]
            continue
        greedy = rng.random() > SIM_RANDOM_MOVE_CHANCE
        swap = _pick_swap(board, rows, cols, rng, greedy)
        if swap is None:
            break
        (r1, c1), (r2, c2), _ = swap
        board[r1][c1], board[r2][c2] = board[r2][c2], board[r1][c1]
        score += _resolve_cascades(board, rows, cols, colors, rng)
    return score


def _calibrate_target(shape: dict, rng: random.Random, ease: float) -> tuple[int, int]:
    """Runs SIM_PLAYOUTS simulated playouts and returns (target, median_sim_score)."""
    scores = sorted(
        _simulate_playout(shape["rows"], shape["cols"], shape["colors"], shape["moves"], rng)
        for _ in range(SIM_PLAYOUTS)
    )
    median = scores[len(scores) // 2]
    # Target is a fraction of what a mixed-skill simulated player achieves,
    # then eased — reachable without perfect play, still a real goal.
    target_ratio = 0.72 * ease
    target = max(200, round(median * target_ratio / 10) * 10)
    return target, median


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


def _place_veils(rng: random.Random, rows: int, cols: int, density: float) -> list[list[int]]:
    if density <= 0:
        return []
    cells = [(r, c) for r in range(rows) for c in range(cols)]
    rng.shuffle(cells)
    n = round(len(cells) * density)
    chosen = cells[:n]
    return [[r, c, 1 if density < 0.14 else 2] for r, c in chosen]


def _collect_targets(rng: random.Random, colors: int, index: int) -> list[dict]:
    kinds = rng.sample(range(colors), k=min(2, colors))
    base = 14 + min(24, index // 3)
    return [{"type": k, "count": base + rng.randint(-2, 3)} for k in kinds]


def _finale_modifiers(mode: str, chapter: int, slot: int) -> dict:
    """slot is 0/1/2 for levels 13/14/15 of the chapter."""
    rng = random.Random(_seed(f"finale::{mode}::{chapter}", slot))
    return {
        "piece": rng.choice(FINALE_PIECES),
        "task": rng.choice(FINALE_TASKS),
        "skin": rng.choice(FINALE_SKINS),
        "constraint": rng.choice(FINALE_CONSTRAINTS),
    }


def _apply_finale(data: dict, shape: dict, mods: dict, rng: random.Random) -> None:
    """Mutates a level dict in place with a finale's modifier axes. Reuses
    existing mechanics (veils, bonus multiplier, timed countdown) rather than
    inventing new match rules, so the core engine doesn't have to change."""
    data["finalePiece"] = mods["piece"]
    data["skin"] = mods["skin"]
    data["finale"] = True

    if mods["piece"] == "lockedChain":
        extra = _place_veils(rng, shape["rows"], shape["cols"], 0.10)
        existing = data["veil"]["cells"] if data.get("veil") else []
        data["veil"] = {"cells": existing + extra}
    elif mods["piece"] == "doublePoints":
        data["bonusMultiplier"] = 2.0
    elif mods["piece"] == "shrinking":
        cells = [(r, c) for r in range(shape["rows"]) for c in range(shape["cols"])]
        rng.shuffle(cells)
        data["shrinkCells"] = [list(rc) for rc in cells[:4]]

    if mods["task"] == "timed":
        data["timedSeconds"] = 300  # 5:00 countdown; Freeze item pauses it 60s

    if mods["constraint"] == "tighterMoves":
        data["moves"] = max(MIN_MOVES_FLOOR, round(data["moves"] * 0.85))
    elif mods["constraint"] == "hazardTile":
        extra = _place_veils(rng, shape["rows"], shape["cols"], 0.08)
        existing = data["veil"]["cells"] if data.get("veil") else []
        data["veil"] = {"cells": existing + extra}
    elif mods["constraint"] == "raisedTarget":
        data["target"] = round(data["target"] * 1.4)
    elif mods["constraint"] == "moreColors":
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

    if objective == "collect":
        cfg.collect = _collect_targets(rng, shape["colors"], index)
        cfg.target = round(target * 0.6)  # score is a secondary bonus goal in collect mode
    elif objective == "veil":
        cfg.veil = {"cells": _place_veils(rng, shape["rows"], shape["cols"], shape["veil_density"])}

    data = cfg.as_dict()
    if is_finale:
        chapter = index // CHAPTER_SIZE + 1
        slot = slot_in_chapter - (CHAPTER_SIZE - 3)
        mods = _finale_modifiers(mode, chapter, slot)
        _apply_finale(data, shape, mods, rng)
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
