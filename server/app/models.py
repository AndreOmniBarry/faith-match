from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class ScoreSubmission(BaseModel):
    """No `player` field, deliberately. Who a score belongs to is read from
    the request's session token in main.py, never from its body — a
    body-supplied name is spoofable, and the one this model used to carry
    defaulted to "Anonymous", which is what every leaderboard row ended up
    being filed under. Older clients that still send one are unaffected:
    pydantic ignores unknown fields, so the value is simply dropped."""

    mode: str
    levelIndex: int = Field(ge=0)
    score: int = Field(ge=0)
    movesUsed: int = Field(ge=0)
    durationMs: Optional[int] = None


class AnalyticsEvent(BaseModel):
    event: str
    payload: Optional[dict] = None


class RegisterRequest(BaseModel):
    username: str
    password: str
    state: Optional[dict] = None  # the signing-up device's current local save, if any


class LoginRequest(BaseModel):
    username: str
    password: str


class SyncRequest(BaseModel):
    state: dict
    updatedAt: Optional[float] = None
