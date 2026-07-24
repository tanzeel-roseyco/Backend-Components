"""
HMAC Token Verification (RFC 8058)
Generates and verifies cryptographically-signed tokens for secure operations.
Use cases: email unsubscribe links, account deletion, preference changes.
"""

import hashlib
import hmac
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

class HMACToken:
    """HMAC-SHA256 token generator and verifier"""

    @staticmethod
    def sign(email: str, secret: str) -> str:
        """
        Generate an HMAC-SHA256 token for a given email and secret.

        Args:
            email: The email address to encode in token
            secret: The secret key (should be ≥32 bytes)

        Returns:
            32-character hex token
        """
        if not secret or len(secret) < 32:
            raise ValueError("Secret must be at least 32 bytes")

        normalized = email.lower().strip()
        hash_obj = hmac.new(
            secret.encode("utf-8"),
            normalized.encode("utf-8"),
            hashlib.sha256,
        )

        # Truncate to 32 chars for reasonable token length
        return hash_obj.hexdigest()[:32]

    @staticmethod
    def verify(email: str, token: str, secret: str) -> bool:
        """
        Verify an HMAC token using constant-time comparison.

        Args:
            email: The email address that was encoded
            token: The token to verify
            secret: The secret key

        Returns:
            True if valid, False otherwise (never reveals why)
        """
        try:
            if not secret or len(secret) < 32:
                return False

            if not email or not token or len(token) != 32:
                return False

            expected = HMACToken.sign(email, secret)

            # Constant-time comparison to prevent timing attacks
            return hmac.compare_digest(token, expected)
        except Exception:
            # Catch any errors and return False (invalid)
            return False


class UnsubscribeRequest(BaseModel):
    email: str
    token: str
    list_id: Optional[str] = None


def create_unsubscribe_routes(secret: str) -> APIRouter:
    """Create unsubscribe endpoints"""
    router = APIRouter()

    @router.get("/unsubscribe")
    async def get_unsubscribe_confirmation(email: str, token: str) -> dict[str, object]:
        """
        GET /unsubscribe?email=...&token=...
        Show confirmation form
        """
        if not HMACToken.verify(email, token, secret):
            raise HTTPException(status_code=404, detail="Not found")

        masked_email = email[:3] + "***@" + email.split("@")[1]
        return {
            "confirmed": True,
            "email": masked_email,
        }

    @router.post("/unsubscribe")
    async def post_unsubscribe(request: UnsubscribeRequest) -> dict[str, bool]:
        """
        POST /unsubscribe
        Actually perform unsubscribe
        """
        if not HMACToken.verify(request.email, request.token, secret):
            raise HTTPException(status_code=401, detail="Unauthorized")

        # TODO: Remove from email list
        # await email_service.unsubscribe(request.email, request.list_id)

        return {"success": True}

    return router


# Usage example:
# from fastapi import FastAPI
# app = FastAPI()
# routes = create_unsubscribe_routes("your-secret-key-min-32-chars-here")
# app.include_router(routes)
#
# # Generate token for user:
# token = HMACToken.sign("user@example.com", secret)
# unsubscribe_url = f"https://example.com/unsubscribe?email=user@example.com&token={token}"
