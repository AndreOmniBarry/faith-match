# Faith Match

A faith-themed match-3, built to run on the Loveworld PEP phone/playstore via
its SDK. Modeled on Candy Crush's proven structure — daily engagement, a real
special-tile/combo system, escalating difficulty, lives, and a reward economy
— but with its own modes, its own "chaos," and a content pipeline meant to
keep growing for years without hand-authoring every level forever.

## Layout

```
index.html          # screen markup shell (splash/loading/modes/dashboard/chapters/path/game)
css/
  base.css           # theme tokens, reset, shared chrome, ambient living background
  screens.css         # every non-board screen: mode select, dashboard, chapters/path, HUD, modal, tray
  board.css           # board frame, tiles, specials, particle canvas, shake/flash/timer keyframes
js/
  state.js            # persistence: per-mode progress, lives, gems, inventory, daily streak
  audio.js             # zero-asset beep-synth sound engine
  api.js                # client for the Python backend, with timeouts (never blocks the game)
  content.js             # mode metadata, curated opening levels, offline fallback level generator
  icons.js                # hand-authored inline SVG tile glyphs (shape-coded, not just color-coded)
  theme.js                 # per-chapter / per-finale accent theming (--chapter-accent)
  lives.js                  # lives/energy: cap, lazy regen math, countdown formatting
  rewards.js                 # gems, inventory items, chapter/level/daily reward tables, streak logic
  engine.js                   # grid, match detection (incl. L/T intersections), specials, combo
                                # pairing table, veil/finale mechanics, combo meter, resolve loop
  effects.js                   # particle system, screen shake, flash, idle board life, confetti
  render.js                     # tile DOM/transform/squash-stretch, SVG icon wiring
  screens.js                     # screen router + HUD chrome + input + level/lives/reward lifecycle
  main.js                         # bootstrap
server/               # Python backend — see server/README.md
```

## Running locally

The frontend is plain ES modules — it needs an http(s) origin (not `file://`)
and pairs naturally with the backend, which also serves it:

```bash
cd server
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Then open `http://localhost:8000/`. The game works without the backend too
(each API call has a ~1.5s timeout and falls back to a local level
generator) — useful for quick UI iteration with any static file server.

## Gameplay

- **Match 3** → pop. **Match 4** → Striped (clears the row/column). **L/T
  shape** → Wrapped (a 5×5-ish blast). **Match 5** → Color Bomb (clears every
  tile of one color).
- **Combine two specials** by swapping them into each other for the classic
  Candy-Crush combo table — the biggest chaos on the board.
- A **Combo Surge meter** fills as you chain cascades/specials; full, it's
  tappable for a random in-level burst (free hammer strike, bonus moves, a
  free Color Bomb, or a score burst).
- The board's idle "life" — ambient shimmer, an occasional hint sparkle
  (biased toward a strong move, with a little randomness around it, not
  always the literal best) — plus a slow drifting ambient background behind
  every screen.

## Lives, gems, and rewards

- 5 lives, one regenerates every 20 minutes; losing a level costs one,
  winning doesn't. Out of lives → wait it out or spend gems on an instant
  refill. Out of moves mid-level → spend gems for a paid "continue" instead
  of an immediate loss.
- Gems and inventory items (Extra Moves, Giant Hammer, Rainbow Shuffle,
  Color Bomb Gift, Freeze) are earned from level/chapter/daily completions
  and spent from the in-game 🎒 tray. No real-money purchase yet — that's
  a later build; the earn/spend economy itself is real today.
- The Dashboard screen (profile icon on Mode Select) shows lives, gems,
  daily streak, inventory, and stars earned per mode.

## Modes

- **Grace Path** — classic score-attack against a move limit.
- **Harvest** — collect a set number of specific symbols.
- **Refiner's Fire** — veiled tiles block swapping until a match beside them
  frees a layer; clear every veil to win.
- **Daily Blessing** — a 3-level session, date-seeded and shared by everyone,
  once per day; completing it extends your streak and pays out a reward
  item. Not endlessly replayable — that's what makes it a "daily."

## Chapters, star-gates, and stage finales

Levels are grouped into chapters of 15. About 40% of chapters carry a
"star-gate" at a seeded, unpredictable position in their back third —
requiring a star total from that chapter so far to proceed, so replaying
earlier levels for a better star count is sometimes required, never every
chapter and never at a fixed spot.

The last 3 levels of every chapter are a **stage finale**: each is composed
from independent seeded modifier axes (a piece behavior, a task type
including a new timed countdown, a visual skin, and a difficulty constraint)
run at a genuinely harder local difficulty than the standard curve — 4×4×6×5
combinations per slot × 3 slots, comfortably past 1,000 non-repeating
finales without hand-authoring any of them.

Beyond a small hand-curated opening run, every level config — including
finales — is generated by a difficulty curve (tuned ~10% gentler than a
typical Candy Crush ramp for standard levels, genuinely harder for finales)
— see `server/app/level_gen.py` for the authoritative version, which
additionally calibrates each level's score target from simulated playouts
rather than a hand guess. This build's documented content range is 1,000
levels/mode (`CONTENT_CEILING_LEVELS`); per the "scope by 1000 each build"
plan, that ceiling — not hand-authored rows — is what grows next time.

The board's tile *colors* are always genuinely random (`Math.random()`,
reseeded every attempt) — only each level's *structure* (size, moves,
target, finale modifiers) is deterministic per level number, the same way
Candy Crush's own levels are. No amount of replaying makes a level
memorizable.

Registration and real-money purchases are intentionally not part of this
pass.
