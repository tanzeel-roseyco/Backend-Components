/**
 * HMAC Token Verification (RFC 8058)
 * Generates and verifies cryptographically-signed tokens for secure operations.
 * Use cases: email unsubscribe links, account deletion, preference changes.
 */

import crypto from 'crypto';

export class HMACToken {
  /**
   * Generate an HMAC-SHA256 token for a given email and secret
   * @param email - The email address to encode in token
   * @param secret - The secret key (should be ≥32 bytes)
   * @returns 32-character hex token
   */
  static sign(email: string, secret: string): string {
    if (!secret || secret.length < 32) {
      throw new Error('Secret must be at least 32 bytes');
    }

    const normalized = email.toLowerCase().trim();
    const hash = crypto.createHmac('sha256', secret).update(normalized).digest('hex');

    // Truncate to 32 chars for reasonable token length
    return hash.substring(0, 32);
  }

  /**
   * Verify an HMAC token using constant-time comparison
   * @param email - The email address that was encoded
   * @param token - The token to verify
   * @param secret - The secret key
   * @returns true if valid, false otherwise (never reveals why)
   */
  static verify(email: string, token: string, secret: string): boolean {
    try {
      if (!secret || secret.length < 32) {
        return false;
      }

      if (!email || !token || token.length !== 32) {
        return false;
      }

      const expected = this.sign(email, secret);

      // Constant-time comparison to prevent timing attacks
      return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
    } catch {
      // Catch any errors and return false (invalid)
      return false;
    }
  }
}

/**
 * Express/Fastify route handlers for unsubscribe pattern
 */
export function createUnsubscribeHandlers(secret: string) {
  return {
    /**
     * GET /unsubscribe?email=...&token=...
     * Show confirmation form
     */
    getConfirmation: async (request: any, response: any) => {
      const { email, token } = request.query;

      if (!HMACToken.verify(email, token, secret)) {
        return response.status(404).json({ error: 'Not found' });
      }

      // Return HTML form or JSON confirmation
      response.json({
        confirmed: true,
        email: email.substring(0, 3) + '***@' + email.split('@')[1],
      });
    },

    /**
     * POST /unsubscribe
     * Actually perform unsubscribe
     */
    postUnsubscribe: async (request: any, response: any) => {
      const { email, token, list_id } = request.body;

      if (!HMACToken.verify(email, token, secret)) {
        return response.status(401).json({ error: 'Unauthorized' });
      }

      // TODO: Remove from email list
      // await emailService.unsubscribe(email, list_id);

      response.status(204).send();
    },
  };
}
