"""Password hashing and session tokens — stdlib only, no bcrypt/passlib/jwt
dependency, matching db.py's own "no external DB dependency" ethos extended
to auth. PBKDF2-HMAC-SHA256 is a real, sound choice (it's literally what
Django defaults to) even without a dedicated password-hashing library.

This is a casual game's account system, not a bank's — basic, honest scope:
no rate-limiting/brute-force lockout in this pass (a known limitation, not
a silent gap), no password recovery flow (username+password only, by
explicit choice — see the Player Profiles plan)."""

from __future__ import annotations

import hashlib
import hmac
import secrets

PBKDF2_ITERATIONS = 200_000
SESSION_TTL_SECONDS = 90 * 24 * 60 * 60  # 90 days, refreshed on every use


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), PBKDF2_ITERATIONS)
    return f"{salt}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt, digest_hex = stored.split("$", 1)
    except ValueError:
        return False
    candidate = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), PBKDF2_ITERATIONS)
    # Constant-time compare — a plain == on the hex strings would leak
    # timing information about how many leading bytes matched.
    return hmac.compare_digest(candidate.hex(), digest_hex)


def new_session_token() -> str:
    return secrets.token_urlsafe(32)
