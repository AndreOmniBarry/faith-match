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

## Why Python here and not in the client

Level calibration runs a batch of simulated playouts (`level_gen.py`) to set
a fair score target instead of a hand-guessed number — a few dozen tiny
match-3 simulations per level, cached after first computation. That's cheap
on a server and expensive/battery-draining to redo on a phone on every
level-select tap, so it stays server-side. The actual 60fps gameplay
(matching, particles, animation) stays in the JS client where it belongs —
there's no in-browser Python (Pyodide) here on purpose: it would add several
MB and hundreds of ms to app startup for logic JS already runs natively.
