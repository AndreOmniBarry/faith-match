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
