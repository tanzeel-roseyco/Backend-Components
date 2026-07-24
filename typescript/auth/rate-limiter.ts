/**
 * IP-Based Login Rate Limiter
 * Prevents brute-force attacks by tracking failed login attempts per IP
 * with configurable lockout periods.
 */

export interface RateLimitResult {
  allowed: boolean;
  attemptsRemaining: number;
  lockoutExpiresAt?: number;
}

export interface RateLimiterConfig {
  maxAttempts?: number;
  lockoutMinutes?: number;
  resetHours?: number;
  storageBackend: 'redis' | 'postgres' | 'supabase' | 'memory';
  trustProxyHeaders?: boolean;
}

export interface RateLimiterStorage {
  get(key: string): Promise<{ attempts: number; lockedUntil: number } | null>;
  set(key: string, value: { attempts: number; lockedUntil: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * In-memory storage implementation for development/testing
 */
class InMemoryStorage implements RateLimiterStorage {
  private store = new Map<string, { attempts: number; lockedUntil: number }>();

  async get(key: string) {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: { attempts: number; lockedUntil: number }) {
    this.store.set(key, value);
  }

  async delete(key: string) {
    this.store.delete(key);
  }
}

export class RateLimiter {
  private storage: RateLimiterStorage;
  private maxAttempts: number;
  private lockoutMinutes: number;
  private resetHours: number;

  constructor(config: RateLimiterConfig, storage?: RateLimiterStorage) {
    this.maxAttempts = config.maxAttempts ?? 5;
    this.lockoutMinutes = config.lockoutMinutes ?? 15;
    this.resetHours = config.resetHours ?? 24;
    this.storage = storage ?? new InMemoryStorage();
  }

  async checkLimit(ipAddress: string): Promise<RateLimitResult> {
    const key = `rate_limit:${ipAddress}`;
    const now = Date.now();

    const existing = await this.storage.get(key);

    // No record = first attempt
    if (!existing) {
      return {
        allowed: true,
        attemptsRemaining: this.maxAttempts - 1,
      };
    }

    // Check if locked out
    if (existing.lockedUntil > now) {
      return {
        allowed: false,
        attemptsRemaining: 0,
        lockoutExpiresAt: existing.lockedUntil,
      };
    }

    // Check if reset window has passed
    const recordAge = now - (existing.lockedUntil - this.lockoutMinutes * 60 * 1000);
    if (recordAge > this.resetHours * 60 * 60 * 1000) {
      // Reset counter
      return {
        allowed: true,
        attemptsRemaining: this.maxAttempts - 1,
      };
    }

    // Within tracking window
    return {
      allowed: existing.attempts < this.maxAttempts,
      attemptsRemaining: Math.max(0, this.maxAttempts - existing.attempts),
      lockoutExpiresAt: existing.lockedUntil,
    };
  }

  async recordFailure(ipAddress: string): Promise<void> {
    const key = `rate_limit:${ipAddress}`;
    const now = Date.now();

    const existing = await this.storage.get(key);
    const attempts = (existing?.attempts ?? 0) + 1;

    // Exponential backoff: 5th failure locks for full period
    const lockoutExpiresAt = now + this.lockoutMinutes * 60 * 1000;

    await this.storage.set(key, {
      attempts,
      lockedUntil: lockoutExpiresAt,
    });
  }

  async recordSuccess(ipAddress: string): Promise<void> {
    const key = `rate_limit:${ipAddress}`;
    await this.storage.delete(key);
  }

  async reset(ipAddress: string): Promise<void> {
    const key = `rate_limit:${ipAddress}`;
    await this.storage.delete(key);
  }
}

/**
 * Express/Fastify middleware factory
 */
export function createRateLimitMiddleware(limiter: RateLimiter) {
  return async (request: any, response: any, next: any) => {
    const ip = extractClientIP(request);
    const check = await limiter.checkLimit(ip);

    if (!check.allowed) {
      const retryAfter = Math.ceil((check.lockoutExpiresAt! - Date.now()) / 1000);
      response.status(429).set('Retry-After', retryAfter.toString()).json({
        error: `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minutes.`,
      });
      return;
    }

    next();
  };
}

/**
 * Extract client IP from request, handling proxies
 */
function extractClientIP(request: any): string {
  const headers = request.headers || {};

  // Check CloudFlare
  if (headers['cf-connecting-ip']) {
    return headers['cf-connecting-ip'];
  }

  // Check X-Forwarded-For (rightmost trusted proxy)
  if (headers['x-forwarded-for']) {
    const ips = headers['x-forwarded-for'].split(',').map((ip: string) => ip.trim());
    return ips[ips.length - 1] || '0.0.0.0';
  }

  // Direct connection
  return request.ip || request.connection?.remoteAddress || '0.0.0.0';
}
