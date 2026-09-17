"""Player profiles — register/login/logout and the cloud save (state
push/pull) that actually makes cross-device progress work. See
server/app/auth.py for password hashing/tokens and server/app/storage/ for
the players/sessions/player_state tables this reads and writes.

Scope, stated plainly: username + password, no email, no password-recovery
flow, last-write-wins sync (fine for a single-player casual game — there's
no real-time concurrent-edit scenario to resolve here). The client
(js/account.js) owns deciding *when* to push/pull and any "which save do
you want to keep" prompt; this module just stores and hands back whatever
JSON blob it's given.

Nothing here knows which database is behind it — db.require_store() hands
back a SQLite store locally and a PostgreSQL one in production, and the
query surface is identical either way."""

from __future__ import annotations

import json
import re
import time

from . import auth, db
from .storage import UsernameTaken

USERNAME_RE = re.compile(r"^[a-zA-Z0-9_]{3,20}$")
MIN_PASSWORD_LEN = 6
MAX_STATE_JSON_BYTES = 200_000  # generous — a real save blob is a few KB


class AccountError(Exception):
    """Carries an HTTP status code so main.py's routes can turn this
    straight into an HTTPException without each route re-deriving one."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _validate_credentials(username: str, password: str) -> None:
    if not USERNAME_RE.match(username or ""):
        raise AccountError(400, "Username must be 3-20 characters: letters, numbers, underscore only.")
    if not password or len(password) < MIN_PASSWORD_LEN:
        raise AccountError(400, f"Password must be at least {MIN_PASSWORD_LEN} characters.")


def _issue_session(player_id: int) -> str:
    token = auth.new_session_token()
    db.require_store().create_session(player_id, token, time.time() + auth.SESSION_TTL_SECONDS)
    return token


def _state_for_player(player_id: int) -> dict | None:
    row = db.require_store().load_player_state(player_id)
    if not row:
        return None
    return {"state": json.loads(row["state_json"]), "updatedAt": row["updated_at"]}


def register(username: str, password: str, initial_state: dict | None) -> dict:
    _validate_credentials(username, password)
    db.ensure_schema()
    store = db.require_store()
    password_hash = auth.hash_password(password)
    try:
        player_id = store.create_player(username, password_hash)
    except UsernameTaken:
        raise AccountError(409, "That username is already taken.")

    updated_at = time.time()
    if initial_state is not None:
        store.save_player_state(player_id, json.dumps(initial_state), updated_at)

    token = _issue_session(player_id)
    return {
        "token": token,
        "username": username,
        "state": initial_state,
        "updatedAt": updated_at if initial_state is not None else None,
    }


def login(username: str, password: str) -> dict:
    db.ensure_schema()
    store = db.require_store()
    player = store.get_player_by_username(username or "")
    if not player or not auth.verify_password(password or "", player["password_hash"]):
        # Deliberately the same error for "no such user" and "wrong
        # password" — distinguishing them just tells an attacker which
        # usernames exist.
        raise AccountError(401, "Incorrect username or password.")

    token = _issue_session(player["id"])
    saved = _state_for_player(player["id"])
    # Opportunistic housekeeping: sessions refresh on use, so the only rows
    # that ever expire belong to players who stopped playing for 90 days.
    # Sweeping them here costs one indexed DELETE on an action that already
    # writes, and keeps the table from growing forever at launch scale.
    try:
        store.purge_expired_sessions()
    except Exception:
        pass  # never fail a login over housekeeping
    return {
        "token": token,
        # Echoed back so the client displays the account's canonical
        # spelling ("Alice") rather than whatever case was typed at the
        # login box ("alice") — logins are case-insensitive.
        "username": player["username"],
        "state": saved["state"] if saved else None,
        "updatedAt": saved["updatedAt"] if saved else None,
    }


def require_player(authorization: str | None) -> tuple[dict, str]:
    """Pulls the Bearer token out of an Authorization header and resolves
    it to a player row, or raises. Also refreshes the session's expiry —
    an account in regular use should never silently time out."""
    token = bearer_token(authorization)
    if not token:
        raise AccountError(401, "Missing or malformed Authorization header.")
    store = db.require_store()
    player = store.get_player_by_token(token)
    if not player:
        raise AccountError(401, "Session expired or invalid — please log in again.")
    store.refresh_session(token, time.time() + auth.SESSION_TTL_SECONDS)
    return player, token


def bearer_token(authorization: str | None) -> str | None:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    return authorization[len("Bearer "):].strip() or None


def resolve_player(authorization: str | None) -> dict | None:
    """require_player's optional sibling, for routes that serve guests and
    signed-in players alike (score submission, leaderboard reads). A
    missing, malformed, expired or simply unusable token means "guest",
    never an error — a player mid-level must not be interrupted because
    their session quietly lapsed."""
    token = bearer_token(authorization)
    if not token or not db.is_available():
        return None
    try:
        return db.require_store().get_player_by_token(token)
    except Exception:
        return None


def logout(authorization: str | None) -> None:
    token = bearer_token(authorization)
    if not token:
        return  # already logged out, as far as the client is concerned
    db.require_store().delete_session(token)


def get_state(authorization: str | None) -> dict:
    player, _ = require_player(authorization)
    saved = _state_for_player(player["id"])
    if not saved:
        return {"state": None, "updatedAt": None}
    return saved


def sync_state(authorization: str | None, state: dict, client_updated_at: float | None) -> dict:
    player, _ = require_player(authorization)
    payload = json.dumps(state)
    if len(payload.encode("utf-8")) > MAX_STATE_JSON_BYTES:
        raise AccountError(413, "Save data is unexpectedly large — this looks wrong, not saving it.")
    updated_at = client_updated_at or time.time()
    db.require_store().save_player_state(player["id"], payload, updated_at)
    return {"ok": True, "updatedAt": updated_at}
