# Faith Match — backend engine

Python service behind the game: infinite level generation with simulated
difficulty calibration, the daily rotating challenge, leaderboards, score
anti-cheat, and analytics. The client is plain JS and stays fully playable
offline via its own local fallback generator (`js/content.js`) — this
service is what upgrades content generation and fairness beyond what a
phone webview should be doing on-device.

## Run locally

```bash
cd server
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

This also serves the static frontend (`../index.html`, `../css`, `../js`) at
`http://localhost:8000/` for convenience — the same process answers both the
UI and `/api/*`. In production the client and API would typically be served
separately (static assets on a CDN, API behind its own host); point the
client at a different origin via `window.FAITHMATCH_API_BASE` if needed.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | liveness + current tuning constants |
| GET | `/api/modes` | mode ids + objective types |
| GET | `/api/levels/{mode}/{index}` | one calibrated level config |
| GET | `/api/chapter/{mode}/{chapter}` | 15 levels at once (chapter is 1-based) |
| GET | `/api/daily` | today's date-seeded Daily Blessing level |
| POST | `/api/score` | submit a run; validated, stars computed, stored |
| GET | `/api/leaderboard/{mode}/{index}` | top scores for a level |
| POST | `/api/analytics/event` | fire-and-forget event log |
| POST | `/api/account/register` | create a profile (username+password); optionally uploads the calling device's current save as the starting cloud state |
| POST | `/api/account/login` | verify credentials, return a session token + saved state |
| POST | `/api/account/logout` | invalidate the session token (`Authorization: Bearer <token>`) |
| GET | `/api/account/state` | fetch the signed-in player's cloud save |
| POST | `/api/account/sync` | overwrite the cloud save with the calling device's current state (last-write-wins) |

Player profiles (`server/app/account.py`, `auth.py`) are what make progress
follow a player across devices — see `js/account.js` for the client side.
Username + password only, no email; passwords are PBKDF2-HMAC-SHA256
hashed with a per-user salt (stdlib `hashlib`/`secrets`, no external auth
dependency), never stored or returned in plaintext. **Requires this backend
to actually be running somewhere with a persistent filesystem** — SQLite's
`data.db` needs real disk, which most serverless hosts (including a plain
static Vercel deploy) don't provide by default. No rate-limiting or
password-recovery flow yet — known, stated limitations, not silent gaps.

## Endless content, and what keeps it fair

The difficulty curve saturates: the board reaches 9x9 by level ~120, the
palette reaches 8 symbols by ~240, the move budget hits its floor by ~66 and
the chapter ease hits its cap at chapter 35. Past level ~510 every level was
the same level, and the score target did not even climb — it wobbled on
simulation noise, so level 12,000 could generate easier than level 600.

From chapter 41 (level 600) `level_gen.py` switches to **eras** of 20
chapters: ease falls to a trough when an era opens and climbs back to the cap
across it, the objective is drawn per level from a pool that widens each era
(score, collect, veil, chain, timed), the board is cut to a shape rather than
grown, the palette widens past the early game's 8 symbols, and each era has
its own relic to collect. Every level before chapter 41 generates exactly what
it always did, byte for byte — a level's score target is what its star
thresholds hang off, so moving one moves a player's stars.

Every goal is read off simulated playouts at the share of players the level's
ease aims to let finish, including the score target in the endless range. The
tools under `tools/` are how that is checked rather than assumed:

| Tool | What it answers |
| --- | --- |
| `goal_report.py [sweep]` | what share of simulated players clear each level, per objective |
| `gen_goal_tables.py` | rebuilds the prebuilt ladders in `app/goal_tables.py` |
| `verify_legacy_levels.py` | has any level below the endless range moved? |
| `verify_offline_parity.py` | does `js/content.js` build the same level the server does? |
| `verify_offline_goals.py` | are the offline fallback's goals still winnable? |
| `fit_offline_score.py` | refits the offline score target to the simulator |

Run `gen_goal_tables.py` after any change to the curve, the simulator or the
board shapes, then `goal_report.py sweep` to see what moved.

The offline fallback in `js/content.js` has no simulator, so its score target
is a fit of the one the simulator measures rather than a guess at its shape.
`fit_offline_score.py` prints the constants it carries; re-run it and copy
them over after changing the simulator or the scoring rules, then
`verify_offline_goals.py` to confirm nothing it generates went unwinnable.

## Why Python here and not in the client

Level calibration runs a batch of simulated playouts (`level_gen.py`) to set
a fair score target instead of a hand-guessed number — a few dozen tiny
match-3 simulations per level, cached after first computation. That's cheap
on a server and expensive/battery-draining to redo on a phone on every
level-select tap, so it stays server-side. The actual 60fps gameplay
(matching, particles, animation) stays in the JS client where it belongs —
there's no in-browser Python (Pyodide) here on purpose: it would add several
MB and hundreds of ms to app startup for logic JS already runs natively.
