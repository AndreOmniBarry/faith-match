"""Vercel serverless entrypoint. Vercel's Python runtime auto-detects an
ASGI `app` object exported from a file under api/ and wraps it directly —
no adapter (Mangum etc.) needed. This just puts server/ on sys.path so
server/app/main.py's own package-relative imports (.account, .daily, ...)
resolve exactly the same way they do when run locally via
`uvicorn app.main:app` from inside server/ — same import chain, same app
object, nothing duplicated or reimplemented here.

See vercel.json for the /api/:path* rewrite that routes every API path to
this one function (Vercel's file-system routing alone would only ever map
api/index.py to the literal /api route, not /api/health etc.).

Storage: this function has no durable filesystem of its own, so accounts,
cloud saves and leaderboards read and write a PostgreSQL database reached
through the DATABASE_URL environment variable. Set it in the Vercel
project's settings (Vercel's Neon/Supabase marketplace integrations set it
for you) and those routes work; leave it unset and they answer 501 with an
explanation rather than pretending to save data that would vanish on the
next cold start. Everything else — level generation, the daily challenge,
score validation, guest play — needs no database and works either way.
See server/README.md for the full setup and server/app/storage/ for how
the backend is chosen.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

from app.main import app  # noqa: E402
