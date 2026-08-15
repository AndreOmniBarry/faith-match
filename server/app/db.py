"""Tiny sqlite-backed persistence for the leaderboard and analytics events.
No external DB dependency — stdlib sqlite3 only, file lives next to the app
so the whole backend stays a `pip install fastapi uvicorn && uvicorn app.main:app`
away from running anywhere, including on-device if the SDK ever wants that."""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data.db"


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = get_conn()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS leaderboard (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mode TEXT NOT NULL,
            level_index INTEGER NOT NULL,
            player TEXT NOT NULL,
            score INTEGER NOT NULL,
            stars INTEGER NOT NULL,
            created_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_leaderboard_level ON leaderboard(mode, level_index, score DESC);

        CREATE TABLE IF NOT EXISTS analytics_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event TEXT NOT NULL,
            payload TEXT,
            created_at REAL NOT NULL
        );
        """
    )
    conn.commit()
    conn.close()


def record_score(mode: str, level_index: int, player: str, score: int, stars: int) -> None:
    conn = get_conn()
    conn.execute(
        "INSERT INTO leaderboard (mode, level_index, player, score, stars, created_at) VALUES (?,?,?,?,?,?)",
        (mode, level_index, player[:40], score, stars, time.time()),
    )
    conn.commit()
    conn.close()


def top_scores(mode: str, level_index: int, limit: int = 10) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT player, score, stars, created_at FROM leaderboard "
        "WHERE mode=? AND level_index=? ORDER BY score DESC LIMIT ?",
        (mode, level_index, limit),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def record_event(event: str, payload: str | None) -> None:
    conn = get_conn()
    conn.execute(
        "INSERT INTO analytics_events (event, payload, created_at) VALUES (?,?,?)",
        (event[:80], payload, time.time()),
    )
    conn.commit()
    conn.close()
