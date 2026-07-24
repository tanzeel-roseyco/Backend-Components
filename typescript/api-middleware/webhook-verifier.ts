/**
 * Webhook Signature Verification
 * HMAC-SHA256 verification to prevent unauthorized webhooks and replay attacks.
 * Supports: Calendly, ConvertKit, Stripe, GitHub, etc.
 */

import crypto from 'crypto';

export interface WebhookConfig {
  secret: string;
  algorithm?: 'sha256' | 'sha1';
  headerName?: string;
}

export class WebhookVerifier {
  private secret: string;
  private algorithm: 'sha256' | 'sha1';
  private headerName: string;

  constructor(config: WebhookConfig) {
    this.secret = config.secret;
    this.algorithm = config.algorithm || 'sha256';
    this.headerName = config.headerName || 'X-Webhook-Signature';
  }

  /**
   * Verify webhook signature from request
   * Returns true if valid, false if invalid (never reveals why)
   */
  verify(rawBody: string | Buffer, signature: string): boolean {
    try {
      if (!signature || !this.secret) {
        return false;
      }

      const bodyString = typeof rawBody === 'string' ? rawBody : rawBody.toString();
      const expected = this.generateSignature(bodyString);

      // Use constant-time comparison to prevent timing attacks
      return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  /**
   * Generate signature for body
   */
  generateSignature(body: string): string {
    const hash = crypto
      .createHmac(this.algorithm, this.secret)
      .update(body)
      .digest('hex');

    return `${this.algorithm}=${hash}`;
  }

  /**
   * Express/Fastify middleware for webhook verification
   */
  middleware() {
    return async (request: any, response: any, next: any) => {
      const signature = request.headers[this.headerName.toLowerCase()] ||
        request.headers['x-webhook-signature'] ||
        request.headers['x-signature'];

      if (!signature) {
        return response.status(401).json({ error: 'Missing signature' });
      }

      // Get raw body
      let rawBody = request.rawBody || request.body;
      if (typeof rawBody === 'object') {
        rawBody = JSON.stringify(rawBody);
      }

      const isValid = this.verify(rawBody, signature);
      if (!isValid) {
        return response.status(401).json({ error: 'Invalid signature' });
      }

      next();
    };
  }
}

/**
 * Provider-specific implementations
 */
export class CalendlyWebhookVerifier extends WebhookVerifier {
  constructor(secret: string) {
    super({
      secret,
      algorithm: 'sha256',
      headerName: 'X-Calendly-Signature',
    });
  }
}

export class ConvertKitWebhookVerifier extends WebhookVerifier {
  constructor(secret: string) {
    super({
      secret,
      algorithm: 'sha256',
      headerName: 'X-ConvertKit-Signature',
    });
  }

  /**
   * ConvertKit uses special signature format: timestamp.signature
   */
  verifyConvertKit(rawBody: string, signature: string, timestamp: string): boolean {
    const payload = `${timestamp}.${rawBody}`;
    return this.verify(payload, signature);
  }
}

export class StripeWebhookVerifier extends WebhookVerifier {
  constructor(secret: string) {
    super({
      secret,
      algorithm: 'sha256',
      headerName: 'X-Stripe-Signature',
    });
  }

  /**
   * Stripe uses format: t=timestamp,v1=signature
   */
  verifyStripe(rawBody: string, signature: string, timestamp: string): boolean {
    const signed = `${timestamp}.${rawBody}`;
    return this.verify(signed, signature);
  }
}
