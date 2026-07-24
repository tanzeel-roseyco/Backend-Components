/**
 * Newsletter Subscription Handler
 * ===============================================================================
 * Dual-platform newsletter/waitlist subscribe endpoint for a serverless
 * function host (originally a Netlify Function; the same handler shape works on
 * any provider that passes an `{ httpMethod, body }` event and expects a
 * `{ statusCode, body }` response).
 *
 * On a single POST it fans out to three side effects, each independently
 * fault-tolerant:
 *   1. Persist the subscription row to a database (Supabase Postgres).
 *   2. Register the subscriber against an email-marketing list/form
 *      (ConvertKit "Kit" v4 API). The target form is chosen by `list` type.
 *   3. Send confirmation email to the subscriber AND a notification email to
 *      the site admin (Resend).
 *
 * Adapted and generalized from a production codebase. All client, brand,
 * person, domain, and copy specifics have been replaced with neutral
 * placeholders and configuration.
 *
 * Required environment variables:
 *   - RESEND_API_KEY               API key for the transactional email provider.
 *   - CONTACT_TO_EMAIL             Admin recipient for signup notifications.
 *   - CONTACT_FROM_EMAIL          "From" header, e.g. `Example Co <hello@example.com>`.
 *   - SUPABASE_URL                 Database project URL (optional; DB write skipped if absent).
 *   - SUPABASE_SERVICE_ROLE_KEY    Server-side DB service key (optional; DB write skipped if absent).
 *   - KIT_API_KEY                  Email-list provider v4 API key (optional; list add skipped if absent).
 *   - KIT_FORM_ID_NEWSLETTER       Default list/form id for standard newsletter signups.
 *   - KIT_FORM_ID_WAITLIST         List/form id for waitlist signups (falls back to newsletter).
 *
 * Key dependencies (peer):
 *   - resend                       Transactional email SDK.
 *   - @supabase/supabase-js        Database client.
 *   - global fetch                 Node 18+ / edge runtime built-in (Kit HTTP calls).
 *
 * Note: Role = public subscribe boundary. Security/ordering constraints:
 *   - ALL secrets come from env only; never hardcode. Service-role DB key must
 *     stay server-side (this file), never shipped to a client bundle.
 *   - Side effects are ordered DB -> Kit -> emails, but each is best-effort and
 *     wrapped so one failure does not abort the others. The request only 5xxs
 *     when the email provider is unconfigured, or when BOTH emails fail.
 *   - `email`/`name` are interpolated into HTML email bodies. Callers upstream
 *     should validate/normalize; see TODO on escapeHtml below — user input
 *     is currently HTML-escaped defensively here to prevent injection into the
 *     admin/subscriber emails.
 */

'use strict';

const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');

// Note: Every secret is read from env with an empty-string default so the
// module loads even when a given integration is intentionally disabled.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// Email-list provider (ConvertKit "Kit") v4 configuration.
// Kit v4 uses a single API key (not a v3 secret). Set KIT_API_KEY in your host's
// environment configuration.
const KIT_API_KEY = process.env.KIT_API_KEY || '';
const KIT_FORM_ID_NEWSLETTER = process.env.KIT_FORM_ID_NEWSLETTER || '';
const KIT_FORM_ID_WAITLIST = process.env.KIT_FORM_ID_WAITLIST || '';

/** Known subscription list types. Unknown values fall back to the newsletter form. */
const LIST_NEWSLETTER = 'newsletter';
const LIST_WAITLIST = 'waitlist';

// Note: Deliberately conservative email shape check — this is a boundary
// guard, not full RFC 5322 validation. It rejects obviously malformed input
// (and stray whitespace/newlines that could confuse the mail provider) before
// we spend a DB write and an outbound email `to:` on garbage. Upstream schema
// validation should still run; see TODO on escapeHtml.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @typedef {Object} ServerlessEvent
 * @property {string} httpMethod           HTTP method, e.g. "POST".
 * @property {string} [body]               Raw JSON request body.
 *
 * @typedef {Object} ServerlessResponse
 * @property {number} statusCode           HTTP status code.
 * @property {string} body                 JSON-serialized response body.
 *
 * @typedef {Object} SubscribeInput
 * @property {string} email                Subscriber email (required).
 * @property {string} [name]               Subscriber display name.
 * @property {string} [list]               List type: "newsletter" | "waitlist".
 * @property {string} [source]             Free-text acquisition source, e.g. "website".
 */

// Note: Internal DB client factory. Returns null (not throwing) when the
// database is unconfigured so the caller can degrade gracefully. If your project
// centralizes this, replace with a shared import, e.g.:
//   const { getSupabaseClient } = require('../lib/supabase');
/**
 * Build a server-side database client, or null when DB env vars are absent.
 * @returns {import('@supabase/supabase-js').SupabaseClient | null}
 */
const getSupabaseClient = () => {
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  if (!supabaseUrl || !supabaseServiceKey) {
    return null;
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
};

/**
 * Escape a string for safe interpolation into HTML email bodies.
 * TODO: Upstream request validation (schema/allowlist) should still run at
 * the API gateway; this is defense-in-depth against HTML/script injection into
 * the confirmation and admin notification emails.
 * @param {string} value
 * @returns {string}
 */
const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Serverless handler for newsletter / waitlist subscriptions.
 *
 * Accepts a POST with a JSON body of {@link SubscribeInput}, persists the row,
 * registers the subscriber with the email-list provider, and sends confirmation
 * plus admin-notification emails. Each side effect is best-effort.
 *
 * @param {ServerlessEvent} event
 * @returns {Promise<ServerlessResponse>}
 */
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    /** @type {SubscribeInput} */
    const body = JSON.parse(event.body || '{}');
    const email = (body.email || '').trim();
    // Note: Cap free-text fields so a hostile caller can't push oversized
    // payloads into the DB column or the outbound email bodies. Truncation is a
    // safe degrade (still delivers a valid signup); email is length-checked
    // against the RFC 5321 254-char limit and rejected rather than truncated.
    const name = (body.name || '').trim().slice(0, 200);
    const list = (body.list || LIST_NEWSLETTER).trim().slice(0, 50);
    const source = (body.source || 'website').trim().slice(0, 200);

    if (!email) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Email is required' }) };
    }

    if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'A valid email is required' }) };
    }

    // --- 1. Persist to database (best-effort) ---------------------------------
    const supabase = getSupabaseClient();
    if (supabase) {
      try {
        // Note: supabase-js resolves (does NOT reject) on DB-level errors —
        // constraint violations, RLS denials, etc. surface via the returned
        // `error` object, so we must inspect it explicitly. The try/catch only
        // guards transport-level throws (network/DNS).
        const { error: dbError } = await supabase.from('subscriptions').insert({
          email,
          name: name || null,
          list,
          source,
        });
        if (dbError) {
          console.error('Failed saving subscription to database', dbError);
        }
      } catch (dbErr) {
        console.error('Database insert threw unexpectedly', dbErr);
        // Continue with email flow even if the DB write fails.
      }
    }

    // --- 2. Register with email-list provider (Kit v4, best-effort) -----------
    let kitAdded = false;
    if (KIT_API_KEY) {
      try {
        // Waitlist signups route to their own form when configured, otherwise
        // fall back to the standard newsletter form.
        const formId =
          list === LIST_WAITLIST
            ? KIT_FORM_ID_WAITLIST || KIT_FORM_ID_NEWSLETTER
            : KIT_FORM_ID_NEWSLETTER;

        if (formId) {
          const kitResponse = await fetch(
            `https://api.kit.com/v4/forms/${formId}/subscribers`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${KIT_API_KEY}`,
              },
              body: JSON.stringify({
                email_address: email,
                first_name: name || undefined,
                fields: {},
              }),
            }
          );

          if (kitResponse.ok) {
            kitAdded = true;
            console.log('Subscriber added to email-list provider successfully');
          } else {
            const errorData = await kitResponse.json().catch(() => ({}));
            console.error('Email-list provider API error:', kitResponse.status, errorData);
          }
        } else {
          console.warn('Email-list form id not configured for list:', list);
        }
      } catch (kitErr) {
        console.error('Failed adding subscriber to email-list provider', kitErr);
        // Continue - do not fail the request if the list provider fails.
      }
    } else {
      console.log('Email-list API key not configured - skipping list integration');
    }

    // --- 3. Send emails (requires configured email provider) ------------------
    if (!RESEND_API_KEY || !resend) {
      console.error('Subscribe function misconfigured: RESEND_API_KEY missing');
      return { statusCode: 500, body: JSON.stringify({ error: 'Email service not configured' }) };
    }

    // Note: From/To identity is fully env-driven. Placeholders shown are
    // safe non-routable examples; real values belong in host env config only.
    const toAdmin = process.env.CONTACT_TO_EMAIL || 'admin@example.com';
    const fromAddress = process.env.CONTACT_FROM_EMAIL || 'Example Co <hello@example.com>';
    let userEmailSent = false;
    let adminEmailSent = false;

    const isWaitlist = list === LIST_WAITLIST;
    const safeName = name ? escapeHtml(name) : '';
    const safeEmail = escapeHtml(email);
    const safeList = escapeHtml(list);
    const safeSource = escapeHtml(source);

    // Confirmation to the subscriber.
    try {
      await resend.emails.send({
        from: fromAddress,
        to: email,
        subject: isWaitlist ? 'You’re on the waitlist' : 'Thanks for subscribing',
        html: `
          <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #111;">
            <h2 style="margin: 0 0 12px;">Thank you${safeName ? `, ${safeName}` : ''}!</h2>
            <p>You're signed up${isWaitlist ? ' for the waitlist' : ''}.</p>
            ${isWaitlist ? '<p>We’ll be in touch as soon as there is news to share.</p>' : ''}
            <p>If you have any questions, just reply to this email.</p>
            <p style="margin-top: 24px;">Warmly,<br/>The Example Co Team</p>
          </div>
        `,
      });
      userEmailSent = true;
    } catch (sendErr) {
      console.error('Failed sending subscriber email', sendErr);
    }

    // Notify the site admin.
    try {
      await resend.emails.send({
        from: fromAddress,
        to: toAdmin,
        subject: `New ${list} signup`,
        html: `
          <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #111;">
            <p><strong>Email:</strong> ${safeEmail}</p>
            ${safeName ? `<p><strong>Name:</strong> ${safeName}</p>` : ''}
            <p><strong>List:</strong> ${safeList}</p>
            <p><strong>Source:</strong> ${safeSource}</p>
          </div>
        `,
      });
      adminEmailSent = true;
    } catch (adminErr) {
      console.error('Failed sending admin notification', adminErr);
    }

    if (userEmailSent || adminEmailSent) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          userEmailSent,
          adminEmailSent,
          kitAdded,
        }),
      };
    }

    return { statusCode: 502, body: JSON.stringify({ error: 'Unable to send emails at the moment' }) };
  } catch (err) {
    console.error('Subscribe function error', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
