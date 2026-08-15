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

## Why Python here and not in the client

Level calibration runs a batch of simulated playouts (`level_gen.py`) to set
a fair score target instead of a hand-guessed number — a few dozen tiny
match-3 simulations per level, cached after first computation. That's cheap
on a server and expensive/battery-draining to redo on a phone on every
level-select tap, so it stays server-side. The actual 60fps gameplay
(matching, particles, animation) stays in the JS client where it belongs —
there's no in-browser Python (Pyodide) here on purpose: it would add several
MB and hundreds of ms to app startup for logic JS already runs natively.
