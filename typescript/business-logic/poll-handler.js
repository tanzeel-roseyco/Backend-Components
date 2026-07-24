/**
 * Poll Response Handler (serverless function)
 * =====================================================================
 * Survey/poll collector for a serverless (Netlify-style) function runtime.
 * On each POST it: (1) persists a poll response to the database, capturing
 * the client IP and User-Agent for basic analytics/abuse tracing, and
 * (2) fires a best-effort admin notification email. The request is always
 * reported as a success to the client for good UX, even when the email
 * step fails — DB persistence and notification are treated as independent,
 * non-blocking side effects.
 *
 * Adapted and generalized from a production codebase.
 *
 * Required environment variables:
 *   SUPABASE_URL               - Base URL of the Supabase project.
 *   SUPABASE_SERVICE_ROLE_KEY  - Service-role key for server-side inserts.
 *   RESEND_API_KEY             - API key for the Resend email provider.
 *   CONTACT_TO_EMAIL           - Admin recipient for poll notifications
 *                                (e.g. admin@example.com).
 *   CONTACT_FROM_EMAIL         - Verified "from" address/name
 *                                (e.g. "Example Co <no-reply@example.com>").
 *
 * Key dependencies:
 *   resend                - Transactional email API client.
 *   @supabase/supabase-js - Postgres/Supabase client.
 *
 * Expected persistence interface (Supabase table `poll_results`):
 *   { choice: string, page: string|null, user_agent: string|null,
 *     ip_address: string|null }
 *
 * AIDEV-NOTE: Role = write-side collector for a public poll widget.
 *   Security/ordering constraints:
 *   - SERVICE_ROLE_KEY grants full DB access; it must ONLY ever live in
 *     server-side env, never reach the client bundle. Read via env only.
 *   - DB persist runs BEFORE email; email failure must NOT roll back or
 *     block the persisted row, and neither failure should surface an error
 *     to the client (always HTTP 200 for UX). Failures are logged only.
 *   - `choice`/`page`/`userAgent`/`ip` are attacker-controlled input. They
 *     are inserted as parameterized values (safe) but interpolated raw into
 *     notification HTML below — see escapeHtml() to prevent injection into
 *     the admin's mail client.
 */

// AIDEV-NOTE: CommonJS require kept to match the serverless runtime's module
// system. Swap to ESM imports if the target runtime uses "type": "module".
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');

/**
 * @typedef {Object} PollEvent
 * @property {string} httpMethod            HTTP method of the invocation.
 * @property {string} [body]                Raw JSON request body.
 * @property {Object.<string,string>} [headers] Request headers (lowercased or not).
 */

/**
 * @typedef {Object} HandlerResponse
 * @property {number} statusCode
 * @property {string} body                  JSON-serialized response body.
 */

// AIDEV-NOTE: Cap attacker-controlled inputs before they hit the DB or the
// notification email. A public poll widget must not let a caller stuff
// arbitrarily large strings (storage abuse / oversized email payloads).
// Limits are generous for legitimate use but bounded.
const MAX_CHOICE_LEN = 200;
const MAX_PAGE_LEN = 512;
const MAX_UA_LEN = 512;
const MAX_IP_LEN = 128;

/**
 * Clamp a string to a maximum length (defensive input bound).
 *
 * @param {string} value Source string (already coerced/trimmed).
 * @param {number} max Maximum retained length.
 * @returns {string} The value truncated to `max` characters.
 */
const clamp = (value, max) => (value.length > max ? value.slice(0, max) : value);

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
// AIDEV-NOTE: Only instantiate the email client when a key is present so the
// function still boots (and DB persistence still works) without email config.
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

/**
 * Escape a string for safe interpolation into HTML.
 *
 * AIDEV-NOTE: The notification email embeds user-controlled fields (choice,
 * page, user-agent, ip). Without escaping, a crafted payload could inject
 * markup/script into the admin's mail client. Always escape before interpolation.
 *
 * @param {unknown} value Raw value to escape.
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
 * Build a server-side Supabase client from environment configuration.
 *
 * @returns {import('@supabase/supabase-js').SupabaseClient | null}
 *   A configured client, or null when required env vars are missing.
 */
const getSupabaseClient = () => {
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  if (!supabaseUrl || !supabaseServiceKey) {
    return null;
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      // AIDEV-NOTE: No token refresh / session persistence on the server —
      // this is a stateless service-role client, not a user session.
      autoRefreshToken: false,
      persistSession: false,
    },
  });
};

/**
 * Serverless entry point for the poll response handler.
 *
 * Accepts POST requests carrying `{ choice, page }`, persists the response
 * (with captured IP/User-Agent) and sends a best-effort admin notification.
 * Always returns HTTP 200 on non-method errors so the client widget shows a
 * successful outcome regardless of email/DB side-effect failures.
 *
 * @param {PollEvent} event Serverless invocation event.
 * @returns {Promise<HandlerResponse>} HTTP response.
 */
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    // AIDEV-NOTE: Coerce -> trim -> clamp every untrusted field so oversized
    // payloads cannot bloat the DB row or the notification email.
    const choice = clamp(String(body.choice || '').trim(), MAX_CHOICE_LEN);
    const page = clamp(String(body.page || '').trim(), MAX_PAGE_LEN);
    const userAgent = clamp(
      String((event.headers && (event.headers['user-agent'] || event.headers['User-Agent'])) || ''),
      MAX_UA_LEN
    );
    // AIDEV-NOTE: Prefer the platform's connection IP header, then fall back to
    // x-forwarded-for. Both are client-influenced; treat as untrusted metadata.
    const ip = clamp(
      String(
        (event.headers &&
          (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'])) ||
          ''
      ),
      MAX_IP_LEN
    );

    if (!choice) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Choice required' }) };
    }

    // --- 1. Persist to database (independent, non-blocking side effect) ---
    let saved = false;
    const supabase = getSupabaseClient();
    if (supabase) {
      try {
        // AIDEV-NOTE: Values are passed as parameterized inserts — safe from
        // SQL injection. Empty strings normalized to null for clean columns.
        const { data, error } = await supabase
          .from('poll_results')
          .insert({
            choice,
            page: page || null,
            user_agent: userAgent || null,
            ip_address: ip || null,
          })
          .select();

        if (error) {
          console.error('Failed saving poll result:', error);
          console.error('Error details:', {
            message: error.message,
            code: error.code,
            details: error.details,
            hint: error.hint,
          });
        } else {
          saved = true;
          console.log('Poll result saved successfully:', data);
        }
      } catch (dbErr) {
        // AIDEV-NOTE: Swallow-and-log is intentional here — a DB failure must
        // not block the email flow or fail the request. Fail-safe for UX.
        console.error('Exception saving poll result:', dbErr);
        console.error('Exception details', {
          message: dbErr && dbErr.message,
          stack: dbErr && dbErr.stack,
        });
      }
    } else {
      console.error('Database client not available - check environment variables');
      console.error('SUPABASE_URL:', process.env.SUPABASE_URL ? 'Set' : 'Missing');
      console.error(
        'SUPABASE_SERVICE_ROLE_KEY:',
        process.env.SUPABASE_SERVICE_ROLE_KEY ? 'Set' : 'Missing'
      );
    }

    // --- 2. Send admin notification email (best-effort) ---
    let emailSent = false;
    if (RESEND_API_KEY && resend) {
      // AIDEV-NOTE: Recipient/sender come from env with neutral fallbacks.
      // Set CONTACT_TO_EMAIL / CONTACT_FROM_EMAIL in production.
      const toAdmin = process.env.CONTACT_TO_EMAIL || 'admin@example.com';
      const fromAddress = process.env.CONTACT_FROM_EMAIL || 'Example Co <no-reply@example.com>';

      try {
        await resend.emails.send({
          from: fromAddress,
          to: toAdmin,
          subject: 'New poll response',
          // AIDEV-NOTE: All interpolated fields are HTML-escaped to prevent
          // markup/script injection into the admin's mail client.
          html: `
            <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #111;">
              <p><strong>Choice:</strong> ${escapeHtml(choice)}</p>
              ${page ? `<p><strong>Page:</strong> ${escapeHtml(page)}</p>` : ''}
              ${userAgent ? `<p><strong>User-Agent:</strong> ${escapeHtml(userAgent)}</p>` : ''}
              ${ip ? `<p><strong>IP (forwarded):</strong> ${escapeHtml(ip)}</p>` : ''}
              <p><em>Sent automatically from website poll.</em></p>
            </div>
          `,
        });
        emailSent = true;
        console.log('Poll notification email sent successfully');
      } catch (emailErr) {
        // AIDEV-NOTE: Email failure is non-fatal — logged, never surfaced.
        console.error('Failed sending poll notification email:', emailErr);
      }
    } else {
      console.error('Poll function misconfigured: RESEND_API_KEY missing');
    }

    // AIDEV-NOTE: Always return success for good UX, even if a side effect
    // failed. `saved`/`emailSent` flags let callers observe partial outcomes.
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        emailSent,
        saved,
      }),
    };
  } catch (err) {
    // AIDEV-NOTE: Catch-all for malformed bodies / unexpected errors. Still
    // returns 200 for UX; the error is logged server-side only, never leaked.
    console.error('Poll function error:', err);
    console.error('Error details:', {
      message: err && err.message,
      stack: err && err.stack,
      body: event.body,
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true, error: 'Internal error logged' }) };
  }
};
