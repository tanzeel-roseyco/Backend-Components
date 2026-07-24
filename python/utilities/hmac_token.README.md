# Python HMAC email tokens

This module signs a lowercased, trimmed email address with HMAC-SHA256 and exposes the first 32 hexadecimal characters. Verification uses `hmac.compare_digest` and returns `False` for invalid input or verification errors.

Secrets are supplied by the caller and must contain at least 32 characters. The included FastAPI route factory provides confirmation and unsubscribe endpoints using a Pydantic request model.

The tokens have no expiry, audience, or operation identifier. The route factory demonstrates the verification boundary, but its unsubscribe endpoint contains placeholder behaviour rather than a mailing-list integration. Add the actual persistence call before treating it as a complete unsubscribe workflow.

Runtime dependencies for the route example are FastAPI and Pydantic. No dedicated test file is present.
