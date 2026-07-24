/**
 * Cookie-Based Authorization Middleware
 * Verify authentication state via secure HTTP-only cookies
 * before allowing protected operations.
 */

import crypto from 'crypto';

export interface AuthResult {
  authenticated: boolean;
  userId?: string;
  error?: string;
}

export interface CookieAuthConfig {
  cookieName?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  expiryMinutes?: number;
  secretKey: string;
}

export class CookieAuthMiddleware {
  private config: CookieAuthConfig;
  private tokenBlacklist: Set<string> = new Set();

  constructor(config: CookieAuthConfig) {
    this.config = {
      cookieName: '__adminauth',
      secure: true,
      httpOnly: true,
      sameSite: 'Strict',
      expiryMinutes: 1440,
      ...config,
    };

    if (!this.config.secretKey || this.config.secretKey.length < 32) {
      throw new Error('Secret key must be at least 32 characters');
    }
  }

  /**
   * Verify authentication from request
   */
  async verify(request: any): Promise<AuthResult> {
    try {
      const cookies = this.parseCookies(request.headers.cookie || '');
      const token = cookies[this.config.cookieName || '__adminauth'];

      if (!token) {
        return {
          authenticated: false,
          error: 'Authorization required',
        };
      }

      // Check blacklist (revoked tokens)
      if (this.tokenBlacklist.has(token)) {
        return {
          authenticated: false,
          error: 'Token revoked',
        };
      }

      // Verify token signature
      const payload = this.verifyToken(token);
      if (!payload) {
        return {
          authenticated: false,
          error: 'Invalid token',
        };
      }

      // Check expiry with clock skew tolerance (60 seconds)
      const now = Date.now();
      if (payload.expiresAt < now - 60000) {
        return {
          authenticated: false,
          error: 'Token expired',
        };
      }

      return {
        authenticated: true,
        userId: payload.userId,
      };
    } catch (error) {
      return {
        authenticated: false,
        error: 'Authentication check failed',
      };
    }
  }

  /**
   * Set authentication cookie on response
   */
  setAuthCookie(response: any, userId: string, expiresInMinutes?: number): any {
    const expiryMs = (expiresInMinutes || this.config.expiryMinutes || 1440) * 60 * 1000;
    const expiresAt = Date.now() + expiryMs;

    const payload = {
      userId,
      expiresAt,
      iat: Date.now(),
    };

    const token = this.generateToken(payload);
    const expires = new Date(expiresAt).toUTCString();

    const cookieHeader = [
      `${this.config.cookieName}=${token}`,
      `Expires=${expires}`,
      `Path=/`,
      `Domain=${this.getDomain()}`,
      this.config.secure ? 'Secure' : '',
      this.config.httpOnly ? 'HttpOnly' : '',
      `SameSite=${this.config.sameSite || 'Strict'}`,
    ]
      .filter(Boolean)
      .join('; ');

    response.setHeader('Set-Cookie', cookieHeader);
    return response;
  }

  /**
   * Clear authentication cookie
   */
  clearAuthCookie(response: any): any {
    const cookieHeader = [
      `${this.config.cookieName}=; Max-Age=0`,
      `Path=/`,
      `Domain=${this.getDomain()}`,
      this.config.secure ? 'Secure' : '',
      this.config.httpOnly ? 'HttpOnly' : '',
      `SameSite=${this.config.sameSite || 'Strict'}`,
    ]
      .filter(Boolean)
      .join('; ');

    response.setHeader('Set-Cookie', cookieHeader);
    return response;
  }

  /**
   * Revoke a token (logout)
   */
  revokeToken(token: string): void {
    this.tokenBlacklist.add(token);
    // In production, persist to Redis with TTL
  }

  /**
   * Generate and sign a token
   */
  private generateToken(payload: any): string {
    const header = {
      alg: 'HS256',
      typ: 'JWT',
    };

    const headerEncoded = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadEncoded = Buffer.from(JSON.stringify(payload)).toString('base64url');

    const signature = crypto
      .createHmac('sha256', this.config.secretKey)
      .update(`${headerEncoded}.${payloadEncoded}`)
      .digest('base64url');

    return `${headerEncoded}.${payloadEncoded}.${signature}`;
  }

  /**
   * Verify and decode token
   */
  private verifyToken(token: string): any {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;

      const [headerEncoded, payloadEncoded, signatureEncoded] = parts;

      // Verify signature
      const expectedSignature = crypto
        .createHmac('sha256', this.config.secretKey)
        .update(`${headerEncoded}.${payloadEncoded}`)
        .digest('base64url');

      if (
        !crypto.timingSafeEqual(
          Buffer.from(signatureEncoded),
          Buffer.from(expectedSignature)
        )
      ) {
        return null;
      }

      // Decode payload
      const payload = JSON.parse(Buffer.from(payloadEncoded, 'base64url').toString());
      return payload;
    } catch {
      return null;
    }
  }

  /**
   * Parse cookies from header
   */
  private parseCookies(cookieHeader: string): Record<string, string> {
    const cookies: Record<string, string> = {};
    cookieHeader.split(';').forEach((cookie) => {
      const [name, value] = cookie.trim().split('=');
      if (name && value) {
        cookies[name] = decodeURIComponent(value);
      }
    });
    return cookies;
  }

  /**
   * Get domain from request
   */
  private getDomain(): string {
    return 'localhost'; // In production, extract from request
  }
}

/**
 * Express/Fastify middleware factory
 */
export function createAuthMiddleware(config: CookieAuthConfig) {
  const auth = new CookieAuthMiddleware(config);

  return async (request: any, response: any, next: any) => {
    const result = await auth.verify(request);
    request.auth = result;

    if (!result.authenticated) {
      return response.status(401).json({ error: result.error || 'Unauthorized' });
    }

    next();
  };
}
