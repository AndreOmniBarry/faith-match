"""Vercel serverless entrypoint. Vercel's Python runtime auto-detects an
ASGI `app` object exported from a file under api/ and wraps it directly —
no adapter (Mangum etc.) needed. This just puts server/ on sys.path so
server/app/main.py's own package-relative imports (.account, .daily, ...)
resolve exactly the same way they do when run locally via
`uvicorn app.main:app` from inside server/ — same import chain, same app
object, nothing duplicated or reimplemented here.

See vercel.json for the /api/:path* rewrite that routes every API path to
this one function (Vercel's file-system routing alone would only ever map
api/index.py to the literal /api route, not /api/health etc.), and
server/app/main.py's IS_VERCEL guards for why the account/leaderboard/
analytics routes answer with a clear 501 here instead of either crashing
or silently losing data — this deployment has no persistent database, only
a real host with durable disk (or a real hosted DB) can serve those.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

from app.main import app  # noqa: E402
