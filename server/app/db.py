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

        -- Player profiles — see server/app/account.py. COLLATE NOCASE so
        -- "Alice" and "alice" are the same account (players won't remember
        -- which case they used on their first device).
        CREATE TABLE IF NOT EXISTS players (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            created_at REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            player_id INTEGER NOT NULL REFERENCES players(id),
            created_at REAL NOT NULL,
            expires_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_player ON sessions(player_id);

        -- One row per player: the whole client-side save blob (see
        -- js/state.js's STORAGE_KEY shape), stored opaquely as JSON. The
        -- server doesn't need to understand its contents, just persist and
        -- hand it back — last-write-wins, timestamped by the client.
        CREATE TABLE IF NOT EXISTS player_state (
            player_id INTEGER PRIMARY KEY REFERENCES players(id),
            state_json TEXT NOT NULL,
            updated_at REAL NOT NULL
        );
        """
    )
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Player profiles / accounts — see server/app/account.py for the endpoint
# logic and server/app/auth.py for password hashing / token generation.
# ---------------------------------------------------------------------------

def create_player(username: str, password_hash: str) -> int:
    """Raises sqlite3.IntegrityError if the username is already taken —
    callers turn that into a 409, not a 500."""
    conn = get_conn()
    cur = conn.execute(
        "INSERT INTO players (username, password_hash, created_at) VALUES (?,?,?)",
        (username, password_hash, time.time()),
    )
    conn.commit()
    player_id = cur.lastrowid
    conn.close()
    return player_id


def get_player_by_username(username: str) -> dict | None:
    conn = get_conn()
    row = conn.execute("SELECT * FROM players WHERE username = ?", (username,)).fetchone()
    conn.close()
    return dict(row) if row else None


def create_session(player_id: int, token: str, expires_at: float) -> None:
    conn = get_conn()
    conn.execute(
        "INSERT INTO sessions (token, player_id, created_at, expires_at) VALUES (?,?,?,?)",
        (token, player_id, time.time(), expires_at),
    )
    conn.commit()
    conn.close()


def get_player_by_token(token: str) -> dict | None:
    """None if the token doesn't exist *or* has expired — callers can't
    tell the difference, which is the point (an expired token should look
    exactly like an invalid one to the client)."""
    conn = get_conn()
    row = conn.execute(
        "SELECT players.* FROM sessions JOIN players ON players.id = sessions.player_id "
        "WHERE sessions.token = ? AND sessions.expires_at > ?",
        (token, time.time()),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def refresh_session(token: str, expires_at: float) -> None:
    conn = get_conn()
    conn.execute("UPDATE sessions SET expires_at = ? WHERE token = ?", (expires_at, token))
    conn.commit()
    conn.close()


def delete_session(token: str) -> None:
    conn = get_conn()
    conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
    conn.commit()
    conn.close()


def save_player_state(player_id: int, state_json: str, updated_at: float) -> None:
    conn = get_conn()
    conn.execute(
        "INSERT INTO player_state (player_id, state_json, updated_at) VALUES (?,?,?) "
        "ON CONFLICT(player_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
        (player_id, state_json, updated_at),
    )
    conn.commit()
    conn.close()


def load_player_state(player_id: int) -> dict | None:
    conn = get_conn()
    row = conn.execute(
        "SELECT state_json, updated_at FROM player_state WHERE player_id = ?", (player_id,)
    ).fetchone()
    conn.close()
    return dict(row) if row else None


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
