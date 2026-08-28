"""
Faith Match backend — the "engine room" behind the game.

Owns everything that benefits from running server-side rather than in a
phone webview: infinite level generation with simulated difficulty
calibration, the daily rotating challenge, leaderboards, score anti-cheat,
and lightweight analytics. The client (plain JS, in ../index.html + ../js/)
is fast and fully playable offline via its own local fallback generator —
this service is what makes the content "ahead of its time" instead of
hand-authored forever, and it's what a future admin/live-ops surface would
sit on top of.

Run:
    cd server
    pip install -r requirements.txt
    uvicorn app.main:app --reload --port 8000

Serves the API under /api/* and, for local dev convenience, the static
frontend (../index.html, ../css, ../js) at "/".
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import account, db
from .account import AccountError
from .daily import get_daily
from .level_gen import CHAPTER_EASE_TABLE, CHAPTER_SIZE, CONTENT_CEILING_LEVELS, get_chapter, get_level
from .models import AnalyticsEvent, LoginRequest, RegisterRequest, ScoreSubmission, SyncRequest
from .scoring import stars_for, validate_score

ROOT_DIR = Path(__file__).resolve().parent.parent.parent

# db.py persists to a sqlite file on local disk (server/data.db) — fine for
# a long-running process (uvicorn on a real host), but Vercel's Python
# functions run on a read-only filesystem outside /tmp, and even /tmp isn't
# shared or durable across invocations. Writing there wouldn't just fail
# silently on account data, it would throw at db.init_db() and take down
# every route (level generation included) at startup. IS_VERCEL gates
# lifespan's init_db() call and every route that touches the db — those
# routes answer honestly (501, see _require_persistent_storage) instead of
# either crashing the whole app or pretending to work with data that will
# vanish on the next cold start.
IS_VERCEL = bool(os.environ.get("VERCEL"))


@asynccontextmanager
async def lifespan(_: FastAPI):
    if not IS_VERCEL:
        db.init_db()
    yield


def _require_persistent_storage() -> None:
    if IS_VERCEL:
        raise HTTPException(
            status_code=501,
            detail=(
                "Player profiles, leaderboards, and score history aren't available on this "
                "deployment yet — this hosting doesn't keep a persistent database, so accounts "
                "would silently vanish on the next cold start instead of actually saving. "
                "Progress still saves fine on this device; cross-device sync needs the backend "
                "hosted somewhere with real persistent storage."
            ),
        )


app = FastAPI(title="Faith Match Engine", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

api = APIRouter(prefix="/api")

VALID_MODES = {"grace-path", "harvest", "refiners-fire", "daily-blessing"}


@api.get("/health")
def health() -> dict:
    return {
        "ok": True, "chapterEaseTable": CHAPTER_EASE_TABLE, "chapterSize": CHAPTER_SIZE,
        "contentCeilingLevels": CONTENT_CEILING_LEVELS,
    }


@api.get("/modes")
def modes() -> dict:
    return {
        "modes": [
            {"id": "grace-path", "objective": "score"},
            {"id": "harvest", "objective": "collect"},
            {"id": "refiners-fire", "objective": "veil"},
            {"id": "daily-blessing", "objective": "score"},
        ]
    }


def _check_mode(mode: str) -> None:
    if mode not in VALID_MODES:
        raise HTTPException(status_code=404, detail=f"unknown mode '{mode}'")


@api.get("/levels/{mode}/{index}")
def level(mode: str, index: int) -> dict:
    _check_mode(mode)
    if index < 0:
        raise HTTPException(status_code=400, detail="index must be >= 0")
    return get_level(mode, index)


@api.get("/chapter/{mode}/{chapter}")
def chapter(mode: str, chapter: int) -> dict:
    _check_mode(mode)
    if chapter < 1:
        raise HTTPException(status_code=400, detail="chapter must be >= 1")
    data = get_chapter(mode, chapter)
    return {"mode": mode, "chapter": chapter, "levels": data["levels"], "gate": data["gate"]}


@api.get("/daily")
def daily(for_date: str | None = None) -> dict:
    try:
        return get_daily(for_date)
    except ValueError:
        raise HTTPException(status_code=400, detail="for_date must be YYYY-MM-DD")


@api.post("/score")
def submit_score(payload: ScoreSubmission) -> dict:
    _check_mode(payload.mode)
    verdict = validate_score(payload.score, payload.movesUsed, payload.durationMs)
    if not verdict["accepted"]:
        return {"accepted": False, "reasons": verdict["reasons"], "stars": 0}

    lvl = get_level(payload.mode, payload.levelIndex)
    moves_left = max(0, lvl["moves"] - payload.movesUsed)
    stars = stars_for(payload.score, lvl["target"], moves_left, lvl["moves"])
    # Stars/anti-cheat validation is pure computation and still real here
    # even on Vercel — only the leaderboard write needs a persistent db,
    # so that's the only part skipped rather than failing the whole call.
    if not IS_VERCEL:
        db.record_score(payload.mode, payload.levelIndex, payload.player, payload.score, stars)
    return {"accepted": True, "stars": stars, "target": lvl["target"]}


@api.get("/leaderboard/{mode}/{index}")
def leaderboard(mode: str, index: int, limit: int = 10) -> dict:
    _check_mode(mode)
    _require_persistent_storage()
    return {"mode": mode, "index": index, "entries": db.top_scores(mode, index, limit)}


@api.post("/analytics/event")
def analytics_event(payload: AnalyticsEvent) -> dict:
    import json

    # Analytics is already fire-and-forget from the client (see
    # js/api.js's sendEvent) — silently skipping the write on Vercel is the
    # right degradation here, not an error.
    if not IS_VERCEL:
        db.record_event(payload.event, json.dumps(payload.payload) if payload.payload else None)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Player profiles — see server/app/account.py. Every route here just
# translates an AccountError (which already carries the right HTTP status)
# into an HTTPException; the actual logic lives in account.py, not here.
# ---------------------------------------------------------------------------

@api.post("/account/register")
def account_register(payload: RegisterRequest) -> dict:
    _require_persistent_storage()
    try:
        return account.register(payload.username, payload.password, payload.state)
    except AccountError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)


@api.post("/account/login")
def account_login(payload: LoginRequest) -> dict:
    _require_persistent_storage()
    try:
        return account.login(payload.username, payload.password)
    except AccountError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)


@api.post("/account/logout")
def account_logout(authorization: str | None = Header(default=None)) -> dict:
    # Best-effort by nature — no persistent storage means no server-side
    # session to invalidate anyway, and the client clears its own token
    # regardless of this response, so this degrades to a no-op rather than
    # an error.
    if not IS_VERCEL:
        account.logout(authorization)
    return {"ok": True}


@api.get("/account/state")
def account_state(authorization: str | None = Header(default=None)) -> dict:
    _require_persistent_storage()
    try:
        return account.get_state(authorization)
    except AccountError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)


@api.post("/account/sync")
def account_sync(payload: SyncRequest, authorization: str | None = Header(default=None)) -> dict:
    _require_persistent_storage()
    try:
        return account.sync_state(authorization, payload.state, payload.updatedAt)
    except AccountError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)


app.include_router(api)

# Local-dev convenience: serve the static frontend from the same process
# when running via `uvicorn app.main:app`. Skipped on Vercel — there this
# app only ever runs as the api/index.py serverless function behind a
# /api/:path* rewrite (see vercel.json), and the static frontend is served
# directly by Vercel's own static hosting instead. Registered last so it
# never shadows the /api/* routes above.
if not IS_VERCEL and (ROOT_DIR / "index.html").exists():
    app.mount("/", StaticFiles(directory=str(ROOT_DIR), html=True), name="frontend")
