// @ts-check
/**
 * Serverless Shared Helpers
 * =========================
 * Small, framework-agnostic utilities for HTTP-style serverless functions
 * (Netlify Functions, AWS Lambda proxy integration, and similar event shapes
 * that expose `httpMethod`, `headers`, and `body`).
 *
 * Provides:
 *   - escapeHtml(value)           : XSS-safe escaping for user input rendered into HTML.
 *   - getClientIp(event)          : Best-effort client IP extraction from proxy headers.
 *   - getUserAgent(event)         : User-Agent header extraction.
 *   - jsonResponse(statusCode, body, headers?) : Standard {statusCode, headers, body} shape.
 *   - assertMethod(event, allowed): Method validation guard returning an error response or null.
 *
 * Required env vars: none. These helpers are pure/stateless. Secrets (e.g.
 * `process.env.RESEND_API_KEY`, `process.env.SUPABASE_SERVICE_ROLE_KEY`,
 * `process.env.ADMIN_EMAIL`) belong to the calling function, not to this module.
 *
 * Key dependencies: none (zero runtime dependencies; Node/JS stdlib only).
 *
 * AIDEV-NOTE: Adapted and generalized from an internal production codebase
 * (a Netlify contact-form function). Only the generic, reusable helpers were
 * lifted out; the form/email/DB logic was intentionally dropped. SECURITY: any
 * user-supplied value interpolated into an HTML string MUST go through
 * escapeHtml FIRST — the original code relied on this ordering for every field.
 * Header lookups are case-insensitive because different platforms normalize
 * header casing differently (Netlify lowercases, some gateways do not).
 */

'use strict';

/**
 * Escape a value for safe interpolation into HTML, preventing XSS.
 * Coerces any input to a string first, then replaces the five HTML-significant
 * characters. Ordering matters: `&` is escaped before the others so we never
 * double-escape an entity we just produced.
 *
 * @param {unknown} value - Arbitrary user input (string, number, null, etc.).
 * @returns {string} HTML-safe string.
 */
const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * @typedef {Object} ServerlessEvent
 * @property {string} [httpMethod] - HTTP method (e.g. "GET", "POST").
 * @property {Record<string, string | undefined>} [headers] - Request headers.
 * @property {string | null} [body] - Raw request body.
 */

/**
 * @typedef {Object} ServerlessResponse
 * @property {number} statusCode - HTTP status code.
 * @property {Record<string, string>} headers - Response headers.
 * @property {string} body - Serialized response body.
 */

/**
 * Case-insensitively read a header from an event's headers map.
 *
 * @param {ServerlessEvent} event - Incoming serverless event.
 * @param {string} name - Header name to look up (any casing).
 * @returns {string | undefined} Header value, or undefined if absent.
 */
const getHeader = (event, name) => {
  const headers = event.headers || {};
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      return headers[key];
    }
  }
  return undefined;
};

/**
 * Best-effort client IP extraction from common proxy/CDN headers.
 *
 * AIDEV-NOTE: Order is deliberate — platform-specific single-IP headers are
 * trusted before `x-forwarded-for`, whose leftmost entry is the original
 * client but is client-spoofable when no trusted proxy overwrites it. Do NOT
 * use the returned IP for authorization decisions without a trusted proxy in
 * front. `x-forwarded-for` may be a comma-separated chain; we take the first.
 *
 * @param {ServerlessEvent} event - Incoming serverless event.
 * @returns {string | null} The client IP, or null if none could be determined.
 */
const getClientIp = (event) => {
  const nfIp = getHeader(event, 'x-nf-client-connection-ip');
  if (nfIp) return nfIp.trim();

  const forwarded = getHeader(event, 'x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0];
    if (first && first.trim()) return first.trim();
  }

  const clientIp = getHeader(event, 'client-ip');
  if (clientIp) return clientIp.trim();

  return null;
};

/**
 * Extract the User-Agent string from the request headers.
 *
 * @param {ServerlessEvent} event - Incoming serverless event.
 * @returns {string | null} The User-Agent, or null if absent.
 */
const getUserAgent = (event) => {
  const ua = getHeader(event, 'user-agent');
  return ua && ua.trim() ? ua.trim() : null;
};

/**
 * Build a standard serverless HTTP response with a JSON body.
 * Centralizes the `{ statusCode, headers, body }` shape so every function
 * returns consistently serialized JSON with the correct content type.
 *
 * @param {number} statusCode - HTTP status code.
 * @param {unknown} body - Any JSON-serializable payload.
 * @param {Record<string, string>} [extraHeaders] - Optional headers to merge in.
 * @returns {ServerlessResponse} The response object.
 */
const jsonResponse = (statusCode, body, extraHeaders = {}) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    ...extraHeaders,
  },
  body: JSON.stringify(body),
});

/**
 * Validate the request method against an allow-list.
 * Returns a ready-to-return 405 response when the method is not allowed, or
 * `null` when the method is permitted (so callers can early-return on truthy).
 *
 * @example
 *   const notAllowed = assertMethod(event, ['POST']);
 *   if (notAllowed) return notAllowed;
 *
 * @param {ServerlessEvent} event - Incoming serverless event.
 * @param {readonly string[]} allowed - Allowed HTTP methods (case-insensitive).
 * @returns {ServerlessResponse | null} A 405 response, or null if allowed.
 */
const assertMethod = (event, allowed) => {
  const method = (event.httpMethod || '').toUpperCase();
  const allowSet = allowed.map((m) => m.toUpperCase());
  if (!allowSet.includes(method)) {
    return jsonResponse(
      405,
      { error: 'Method not allowed' },
      { Allow: allowSet.join(', ') },
    );
  }
  return null;
};

module.exports = {
  escapeHtml,
  getHeader,
  getClientIp,
  getUserAgent,
  jsonResponse,
  assertMethod,
};
