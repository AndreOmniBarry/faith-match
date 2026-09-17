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

Two kinds of route live here, and the difference decides everything about
how they degrade:

* Stateless ones — levels, chapters, the daily challenge, score validation
  — compute their answer and never touch a database. They work on any host,
  including a serverless one with no database attached, and they are what
  guest play runs on.
* Stateful ones — accounts, cloud saves, leaderboards, analytics — need
  somewhere durable to write. They're gated on `db.is_available()` (see
  server/app/storage/__init__.py for what makes that true) rather than on
  which host this happens to be, so attaching a DATABASE_URL turns them on
  with no code change.
"""

from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import account, db
from .account import AccountError
from .daily import get_daily
from .level_gen import CHAPTER_EASE_TABLE, CHAPTER_SIZE, CONTENT_CEILING_LEVELS, get_chapter, get_level
from .models import AnalyticsEvent, LoginRequest, RegisterRequest, ScoreSubmission, SyncRequest
from .scoring import stars_for, validate_score
from .storage import StorageConfigurationError, StorageError, is_serverless

log = logging.getLogger("faithmatch")

ROOT_DIR = Path(__file__).resolve().parent.parent.parent

NO_STORAGE_DETAIL = (
    "Player profiles, leaderboards and cloud saves need a database, and this deployment "
    "doesn't have one configured yet. Set DATABASE_URL to a PostgreSQL connection string "
    "(see server/README.md) and these endpoints start working with no code change. "
    "Progress still saves on the device in the meantime — only cross-device sync and "
    "leaderboards are affected."
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Deliberately non-fatal. A database that's still waking up (a
    # scale-to-zero Postgres cold start is a real, normal event) must not
    # stop the service from serving levels — db.ensure_schema() retries on
    # the first request that actually needs a table.
    db.init_schema()
    yield


def _require_persistent_storage() -> None:
    if not db.is_available():
        raise HTTPException(status_code=501, detail=NO_STORAGE_DETAIL)


app = FastAPI(title="Faith Match Engine", version="0.2.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(StorageError)
async def _storage_error_handler(_: Request, exc: StorageError) -> JSONResponse:
    """A configured database that can't be reached is a 503, not a 500 — the
    dependency is down, the application isn't broken.

    The two cases get different words because they need different actions.
    A dropped connection or a database still waking up really does clear on
    a retry. A driver that isn't installed never will, and telling a player
    to "try again in a moment" about it sends them into a loop while hiding
    from whoever runs the deployment that something needs changing. The
    exact cause goes to the log either way; the player gets a sentence
    that's true.
    """
    if isinstance(exc, StorageConfigurationError):
        log.error("storage misconfigured — this will not fix itself: %s", exc)
        return JSONResponse(
            status_code=503,
            content={"detail": (
                "Player profiles and leaderboards aren't available on this deployment — its "
                "database isn't set up correctly. Your progress is still saved on this device."
            )},
        )
    log.warning("storage unavailable: %s", exc)
    return JSONResponse(
        status_code=503,
        content={"detail": "The game's database is briefly unavailable. Please try again in a moment."},
    )


api = APIRouter(prefix="/api")

VALID_MODES = {"grace-path", "harvest", "refiners-fire", "daily-blessing"}


@api.get("/health")
def health() -> dict:
    return {
        "ok": True, "chapterEaseTable": CHAPTER_EASE_TABLE, "chapterSize": CHAPTER_SIZE,
        "contentCeilingLevels": CONTENT_CEILING_LEVELS,
        # Enough to tell from outside whether this deployment can persist
        # anything, without having to provoke a 501 to find out.
        "storage": db.describe(),
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
def submit_score(payload: ScoreSubmission, authorization: str | None = Header(default=None)) -> dict:
    """Validates a run and computes its stars for everyone, signed in or
    not — that part is pure computation and works on any deployment.

    Who the score belongs to comes from the session token, never from the
    request body. The old `player` field was client-supplied, which meant
    it was both spoofable (post any name you like onto any board) and, in
    practice, always missing — the client never sent one, so every row on
    every board was filed under the default, "Anonymous". A name is not an
    identity; the Bearer token is.

    A guest's run is still validated and still returns stars. It just
    doesn't reach the leaderboard, because there is no player to attribute
    it to — an unattributable row is noise on the board, not a score.
    """
    _check_mode(payload.mode)
    verdict = validate_score(payload.score, payload.movesUsed, payload.durationMs)
    if not verdict["accepted"]:
        return {"accepted": False, "reasons": verdict["reasons"], "stars": 0, "recorded": False}

    lvl = get_level(payload.mode, payload.levelIndex)
    moves_left = max(0, lvl["moves"] - payload.movesUsed)
    stars = stars_for(payload.score, lvl["target"], moves_left, lvl["moves"])

    result = {"accepted": True, "stars": stars, "target": lvl["target"], "recorded": False}
    if not db.is_available():
        return result

    player = account.resolve_player(authorization)
    if player is None:
        return result  # guest run: validated, starred, not ranked

    db.ensure_schema()
    store = db.require_store()
    improved = store.record_score(
        payload.mode, payload.levelIndex, player["id"], player["username"], payload.score, stars
    )
    result["recorded"] = True
    result["personalBest"] = improved
    result["player"] = player["username"]
    result["rank"] = store.player_rank(payload.mode, payload.levelIndex, payload.score)
    return result


@api.get("/leaderboard/{mode}/{index}")
def leaderboard(mode: str, index: int, limit: int = 10,
                authorization: str | None = Header(default=None)) -> dict:
    _check_mode(mode)
    _require_persistent_storage()
    db.ensure_schema()
    store = db.require_store()
    limit = max(1, min(limit, 100))
    entries = store.top_scores(mode, index, limit)

    # The signed-in player's own row, even when they're nowhere near the
    # top ten. A board a player can never see themselves on is a board they
    # stop opening.
    you = None
    player = account.resolve_player(authorization)
    if player is not None:
        best = store.player_best(mode, index, player["id"])
        if best:
            you = {**best, "rank": store.player_rank(mode, index, best["score"])}

    return {"mode": mode, "index": index, "entries": entries, "you": you}


@api.post("/analytics/event")
def analytics_event(payload: AnalyticsEvent) -> dict:
    # Analytics is already fire-and-forget from the client (see js/api.js's
    # sendEvent). On a deployment with no database, silently skipping the
    # write is the right degradation — an analytics failure must never
    # surface to a player.
    if db.is_available():
        try:
            db.ensure_schema()
            db.require_store().record_event(
                payload.event, json.dumps(payload.payload) if payload.payload else None
            )
        except Exception as exc:
            log.warning("dropped analytics event %r: %s", payload.event, exc)
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
    # Best-effort by nature — the client clears its own token regardless of
    # this response, so a deployment with no database degrades to a no-op
    # rather than an error the player would have to acknowledge.
    if db.is_available():
        try:
            account.logout(authorization)
        except Exception as exc:
            log.warning("logout could not clear the server-side session: %s", exc)
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
# when running via `uvicorn app.main:app`. Skipped on serverless hosts —
# there this app only ever runs as the api/index.py function behind a
# /api/:path* rewrite (see vercel.json), and the static frontend is served
# by the platform's own static hosting instead. Registered last so it never
# shadows the /api/* routes above.
if not is_serverless() and (ROOT_DIR / "index.html").exists():
    app.mount("/", StaticFiles(directory=str(ROOT_DIR), html=True), name="frontend")
