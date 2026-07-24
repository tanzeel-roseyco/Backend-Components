"""
IP-Based Login Rate Limiter
Prevents brute-force attacks by tracking failed login attempts per IP
with configurable lockout periods.
"""

from dataclasses import dataclass
from typing import Optional
from datetime import datetime, timedelta
import time


@dataclass
class RateLimitResult:
    """Result of a rate limit check"""
    allowed: bool
    attempts_remaining: int
    lockout_expires_at: Optional[int] = None


class RateLimiterStorage:
    """Abstract storage backend for rate limit data"""

    async def get(self, key: str) -> Optional[dict]:
        """Get rate limit record"""
        raise NotImplementedError

    async def set(self, key: str, value: dict) -> None:
        """Set rate limit record"""
        raise NotImplementedError

    async def delete(self, key: str) -> None:
        """Delete rate limit record"""
        raise NotImplementedError


class InMemoryStorage(RateLimiterStorage):
    """In-memory storage for development/testing"""

    def __init__(self):
        self.store: dict = {}

    async def get(self, key: str) -> Optional[dict]:
        return self.store.get(key)

    async def set(self, key: str, value: dict) -> None:
        self.store[key] = value

    async def delete(self, key: str) -> None:
        self.store.pop(key, None)


class RateLimiter:
    """IP-based rate limiter for authentication endpoints"""

    def __init__(
        self,
        max_attempts: int = 5,
        lockout_minutes: int = 15,
        reset_hours: int = 24,
        storage: Optional[RateLimiterStorage] = None,
    ):
        self.max_attempts = max_attempts
        self.lockout_minutes = lockout_minutes
        self.reset_hours = reset_hours
        self.storage = storage or InMemoryStorage()

    async def check_limit(self, ip_address: str) -> RateLimitResult:
        """Check if IP is rate limited"""
        key = f"rate_limit:{ip_address}"
        now = int(time.time() * 1000)  # milliseconds

        existing = await self.storage.get(key)

        # No record = first attempt
        if not existing:
            return RateLimitResult(
                allowed=True,
                attempts_remaining=self.max_attempts - 1,
            )

        # Check if locked out
        if existing.get("locked_until", 0) > now:
            return RateLimitResult(
                allowed=False,
                attempts_remaining=0,
                lockout_expires_at=existing.get("locked_until"),
            )

        # Check if reset window has passed
        record_age = now - (existing.get("locked_until", now) - self.lockout_minutes * 60 * 1000)
        if record_age > self.reset_hours * 60 * 60 * 1000:
            # Reset counter
            return RateLimitResult(
                allowed=True,
                attempts_remaining=self.max_attempts - 1,
            )

        # Within tracking window
        attempts = existing.get("attempts", 0)
        return RateLimitResult(
            allowed=attempts < self.max_attempts,
            attempts_remaining=max(0, self.max_attempts - attempts),
            lockout_expires_at=existing.get("locked_until"),
        )

    async def record_failure(self, ip_address: str) -> None:
        """Record a failed login attempt"""
        key = f"rate_limit:{ip_address}"
        now = int(time.time() * 1000)

        existing = await self.storage.get(key)
        attempts = (existing.get("attempts", 0) if existing else 0) + 1

        locked_until = now + self.lockout_minutes * 60 * 1000

        await self.storage.set(
            key,
            {
                "attempts": attempts,
                "locked_until": locked_until,
            },
        )

    async def record_success(self, ip_address: str) -> None:
        """Record a successful login (reset counter)"""
        key = f"rate_limit:{ip_address}"
        await self.storage.delete(key)

    async def reset(self, ip_address: str) -> None:
        """Manually reset rate limit for IP (admin action)"""
        key = f"rate_limit:{ip_address}"
        await self.storage.delete(key)


def extract_client_ip(request) -> str:
    """Extract client IP from Flask/FastAPI request"""
    # Check CloudFlare
    if request.headers.get("cf-connecting-ip"):
        return request.headers.get("cf-connecting-ip")

    # Check X-Forwarded-For
    if request.headers.get("x-forwarded-for"):
        ips = [ip.strip() for ip in request.headers.get("x-forwarded-for", "").split(",")]
        return ips[-1] if ips else "0.0.0.0"

    # Direct connection
    return request.remote_addr or "0.0.0.0"


def rate_limit_middleware(limiter: RateLimiter):
    """FastAPI dependency for rate limiting"""

    async def check_rate_limit(request):
        ip = extract_client_ip(request)
        limit = await limiter.check_limit(ip)

        if not limit.allowed:
            retry_after = int((limit.lockout_expires_at - int(time.time() * 1000)) / 1000)
            return {
                "error": f"Too many attempts. Try again in {retry_after // 60} minutes.",
                "status_code": 429,
            }

        return {"allowed": True}

    return check_rate_limit
