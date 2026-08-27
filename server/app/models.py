from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class ScoreSubmission(BaseModel):
    mode: str
    levelIndex: int = Field(ge=0)
    score: int = Field(ge=0)
    movesUsed: int = Field(ge=0)
    durationMs: Optional[int] = None
    player: str = "Anonymous"


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
