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

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import db
from .daily import get_daily
from .level_gen import CHAPTER_EASE_TABLE, CHAPTER_SIZE, CONTENT_CEILING_LEVELS, get_chapter, get_level
from .models import AnalyticsEvent, ScoreSubmission
from .scoring import stars_for, validate_score

ROOT_DIR = Path(__file__).resolve().parent.parent.parent


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init_db()
    yield


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
    stars = stars_for(payload.score, lvl["target"])
    db.record_score(payload.mode, payload.levelIndex, payload.player, payload.score, stars)
    return {"accepted": True, "stars": stars, "target": lvl["target"]}


@api.get("/leaderboard/{mode}/{index}")
def leaderboard(mode: str, index: int, limit: int = 10) -> dict:
    _check_mode(mode)
    return {"mode": mode, "index": index, "entries": db.top_scores(mode, index, limit)}


@api.post("/analytics/event")
def analytics_event(payload: AnalyticsEvent) -> dict:
    import json

    db.record_event(payload.event, json.dumps(payload.payload) if payload.payload else None)
    return {"ok": True}


app.include_router(api)

# Local-dev convenience: serve the static frontend from the same process.
# Registered last so it never shadows the /api/* routes above.
if (ROOT_DIR / "index.html").exists():
    app.mount("/", StaticFiles(directory=str(ROOT_DIR), html=True), name="frontend")
