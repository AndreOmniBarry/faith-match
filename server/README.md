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

## Storage

One environment variable decides where accounts, cloud saves, leaderboards
and analytics are written:

| `DATABASE_URL` | Host | Backend | Behaviour |
| --- | --- | --- | --- |
| a `postgres://` URL | anywhere | PostgreSQL | everything works |
| unset | a normal server / your laptop | SQLite (`server/data.db`) | everything works |
| unset | serverless (Vercel, Lambda, Cloud Run) | none | those routes answer `501`, the rest of the game is unaffected |

`POSTGRES_URL` is accepted as an alias, because that is the name Vercel
Postgres sets. `GET /api/health` reports which backend is live, so you can
tell from outside whether a deployment can persist anything:

```json
{ "storage": { "backend": "postgres", "persistent": true, "serverless": true, "reachable": true } }
```

### Why PostgreSQL for production

Not because the game needs Postgres specifically — it needs *any* durable,
shared store — but because Postgres is the one interface every serious host
speaks. Neon, Supabase, Vercel Postgres, Cloud SQL, RDS and a self-managed
cluster all take the same `DATABASE_URL` and run the same code, so the
hosting decision stays reversible. A serverless function's filesystem is
read-only outside `/tmp`, and `/tmp` is neither shared between instances nor
kept across cold starts, which is why SQLite cannot be the production answer
here however convenient it is locally.

Point `DATABASE_URL` at the provider's **pooled** connection string (Neon
and Supabase both publish a pgbouncer endpoint). Serverless scales out by
running many instances, and each one keeps its own small pool
(`min_size=0`, `max_size=4`, tunable via `FAITHMATCH_DB_MAX_CONNECTIONS`);
the ceiling that matters is the database's, and a pooler is what keeps that
comfortable.

Connect and pool-wait timeouts default to 5s each
(`FAITHMATCH_DB_CONNECT_TIMEOUT`, `FAITHMATCH_DB_POOL_TIMEOUT`). They are
deliberately shorter than the client's own 8s patience for an account
request: a server still dialling a dead database after the client has
given up is billing serverless time for an answer nobody will read.

### What degrades, and what doesn't

Everything that needs no database keeps working on any deployment: level
generation, chapters, the daily challenge, score validation and star
calculation, and therefore **all of guest play**. Only cross-device sync
and leaderboards need a database, and when there isn't one they say so with
a `501` rather than accepting a signup and losing the account on the next
cold start. A database that is configured but momentarily unreachable
answers `503`, not `500` — a retry, not a bug.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | liveness + current tuning constants |
| GET | `/api/modes` | mode ids + objective types |
| GET | `/api/levels/{mode}/{index}` | one calibrated level config |
| GET | `/api/chapter/{mode}/{chapter}` | 15 levels at once (chapter is 1-based) |
| GET | `/api/daily` | today's date-seeded Daily Blessing level |
| POST | `/api/score` | submit a run; validated, stars computed, recorded against the sender's account if they're signed in |
| GET | `/api/leaderboard/{mode}/{index}` | top scores for a level, plus the caller's own entry as `you` |
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
dependency), never stored or returned in plaintext. No rate-limiting or
password-recovery flow yet — known, stated limitations, not silent gaps.

## Who a score belongs to

Identity comes from the `Authorization: Bearer <token>` header, never from
the request body. `POST /api/score` used to accept a `player` name in its
JSON, defaulting to `"Anonymous"` — and since the client never sent one,
every row on every board was stored as `Anonymous`. The field is gone; an
older client that still sends one has it ignored.

The board keeps **one row per player per level**, holding that player's
best, upserted so a worse run can never displace a better one. A guest's
run is still validated and still returns its stars; it just isn't ranked,
because there is no player to attribute it to.

## Tests

```bash
cd server
pip install -r requirements.txt
pytest                      # SQLite only; the PostgreSQL round is skipped

TEST_DATABASE_URL=postgresql://user:pass@localhost/faithmatch_test pytest
```

Every storage and API test runs against both backends. The two engines
disagree about enough — placeholder style, `RETURNING`, case-insensitive
uniqueness, upsert semantics — that a SQLite-only suite would say very
little about the deployment that actually matters. The PostgreSQL round
drops and recreates its tables, so give it a scratch database.

## Why Python here and not in the client

Level calibration runs a batch of simulated playouts (`level_gen.py`) to set
a fair score target instead of a hand-guessed number — a few dozen tiny
match-3 simulations per level, cached after first computation. That's cheap
on a server and expensive/battery-draining to redo on a phone on every
level-select tap, so it stays server-side. The actual 60fps gameplay
(matching, particles, animation) stays in the JS client where it belongs —
there's no in-browser Python (Pyodide) here on purpose: it would add several
MB and hundreds of ms to app startup for logic JS already runs natively.
