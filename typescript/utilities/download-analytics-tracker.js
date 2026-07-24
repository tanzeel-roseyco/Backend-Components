/**
 * Download Analytics Tracker
 * ==========================
 *
 * Resource-download analytics endpoint. Records a download event
 * (title, URL, optional user identity, traffic source attribution,
 * client IP, and user-agent) into a database table for later analysis.
 *
 * Shipped as a serverless HTTP handler (Netlify Functions / AWS Lambda
 * proxy-integration shape), but the core `recordDownload` logic is
 * transport-agnostic and can be reused from any runtime.
 *
 * Generalized from a production codebase; all identifying details removed.
 *
 * Required environment variables:
 *   - SUPABASE_URL               Base URL of the Supabase project.
 *   - SUPABASE_SERVICE_ROLE_KEY  Service-role key (server-side only; never expose to clients).
 *
 * Optional environment variables:
 *   - DOWNLOADS_TABLE            Target table name (default: "audio_downloads").
 *
 * Key dependencies:
 *   - @supabase/supabase-js  Database client. Swap `createDbClient` if using
 *                            a different persistence layer (see the DbClient
 *                            interface declared below).
 *
 * Note: This handler persists PII (email, name, IP, user-agent). Treat
 * the table as sensitive: restrict read access, honor retention/erasure
 * policies, and NEVER log the service-role key. The service-role key bypasses
 * row-level security, so this code MUST run server-side only. Insert failures
 * return HTTP 500 so the caller can retry; the write is best-effort and not
 * idempotent — dedupe downstream if exactly-once semantics are needed.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

// Note: Default table name; override via DOWNLOADS_TABLE without a code change.
const DEFAULT_TABLE = 'audio_downloads';

/**
 * Minimal shape of the persistence client this module depends on. Declared so
 * the module documents its expected interface even though the concrete impl is
 * Supabase. Any object exposing `.from(table).insert(row)` returning a promise
 * satisfies this contract.
 *
 * @typedef {Object} DbClient
 * @property {(table: string) => { insert: (row: Record<string, unknown>) => Promise<{ error: unknown }> }} from
 */

/**
 * A single download event ready for persistence.
 *
 * @typedef {Object} DownloadRecord
 * @property {string} audio_title
 * @property {string|null} audio_url
 * @property {string|null} user_email
 * @property {string|null} user_name
 * @property {string} source
 * @property {string|null} ip_address
 * @property {string|null} user_agent
 */

/**
 * Serverless proxy-integration event (Netlify/Lambda shape).
 *
 * @typedef {Object} HandlerEvent
 * @property {string} httpMethod
 * @property {string|null} [body]
 * @property {Record<string, string|undefined>} [headers]
 */

/**
 * HTTP response for the proxy integration.
 *
 * @typedef {Object} HandlerResponse
 * @property {number} statusCode
 * @property {string} body
 */

/**
 * Build a server-side database client from environment configuration.
 *
 * Returns `null` when credentials are absent so callers can degrade
 * gracefully (e.g. in local dev without a database configured) rather than
 * throwing on every request.
 *
 * @returns {DbClient|null} Configured client, or null if env vars are missing.
 */
function createDbClient() {
  const url = process.env.SUPABASE_URL || '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  if (!url || !serviceKey) {
    return null;
  }

  // Note: Disable token auto-refresh/session persistence — this is a
  // stateless server context, not a long-lived authenticated user session.
  return createClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/**
 * Read a header case-insensitively for the small set of keys we care about.
 *
 * @param {Record<string, string|undefined>} headers
 * @param {string} lowerKey - The header name in lowercase.
 * @returns {string}
 */
function readHeader(headers, lowerKey) {
  const direct = headers[lowerKey];
  if (direct) return direct;
  // Fall back to a case-insensitive scan (e.g. "User-Agent").
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerKey) return headers[key] || '';
  }
  return '';
}

/**
 * Extract the client IP from proxy headers, tolerating both the platform
 * connection-IP header and the standard forwarding header.
 *
 * @param {Record<string, string|undefined>} headers - Case-varying request headers.
 * @returns {string} The best-guess client IP, or '' if none present.
 */
function extractClientIp(headers) {
  // Note: Use case-insensitive reads — Lambda/API Gateway do not lowercase
  // header keys the way Netlify does, so a direct lookup can miss the header.
  const platformIp = readHeader(headers, 'x-nf-client-connection-ip');
  if (platformIp) return platformIp;

  // Note: X-Forwarded-For is "client, proxy1, proxy2..." — the left-most
  // entry is the originating client; take only that and drop the proxy chain.
  const forwarded = readHeader(headers, 'x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();

  return '';
}

/**
 * Persist a single download event.
 *
 * Transport-agnostic core logic. Validates the required `audio_title`,
 * normalizes empty optional fields to `null`, and writes one row.
 *
 * @param {DbClient} db - Persistence client (see {@link DbClient}).
 * @param {DownloadRecord} record - The event to insert.
 * @param {string} [table=DEFAULT_TABLE] - Target table name.
 * @returns {Promise<void>} Resolves on success; rejects if the insert fails.
 */
async function recordDownload(db, record, table = DEFAULT_TABLE) {
  const { error } = await db.from(table).insert(record);
  // Note: supabase-js resolves (not rejects) on DB errors — must inspect
  // `error` explicitly, otherwise write failures pass silently.
  if (error) {
    throw new Error(`Download insert failed: ${String(error)}`);
  }
}

/**
 * Serverless HTTP handler for tracking a resource download.
 *
 * Accepts POST with a JSON body:
 *   { audioTitle, audioUrl?, userEmail?, userName?, source? }
 *
 * Enriches the event with the client IP and user-agent from request headers,
 * then persists it. When no database is configured the request is accepted
 * as a no-op (200) so front-ends do not break in unconfigured environments.
 *
 * @param {HandlerEvent} event - Incoming proxy-integration event.
 * @returns {Promise<HandlerResponse>} Proxy-integration HTTP response.
 */
async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    /** @type {Record<string, unknown>} */
    const body = JSON.parse(event.body || '{}');
    const headers = event.headers || {};

    const audioTitle = String(body.audioTitle || '').trim();
    const audioUrl = String(body.audioUrl || '').trim();
    const userEmail = String(body.userEmail || '').trim();
    const userName = String(body.userName || '').trim();
    const source = String(body.source || 'website').trim();
    const userAgent = readHeader(headers, 'user-agent');
    const ip = extractClientIp(headers);

    // Required-field guard: a download event without a title is meaningless.
    if (!audioTitle) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Audio title is required' }) };
    }

    const db = createDbClient();
    if (db) {
      /** @type {DownloadRecord} */
      const record = {
        audio_title: audioTitle,
        audio_url: audioUrl || null,
        user_email: userEmail || null,
        user_name: userName || null,
        source,
        ip_address: ip || null,
        user_agent: userAgent || null,
      };

      try {
        await recordDownload(db, record, process.env.DOWNLOADS_TABLE || DEFAULT_TABLE);
      } catch (dbErr) {
        // Note: Log without leaking the payload's PII beyond the message.
        console.error('Failed saving download event', dbErr);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to track download' }) };
      }
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('Track download function error', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
  }
}

module.exports = {
  handler,
  recordDownload,
  createDbClient,
  extractClientIp,
  DEFAULT_TABLE,
};

// Netlify Functions entrypoint convention.
exports.handler = handler;
