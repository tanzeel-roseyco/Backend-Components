/**
 * Calendly Webhook Handler
 * =========================
 *
 * Serverless (Netlify-style) HTTP handler for Calendly webhooks. It:
 *   1. Verifies the inbound webhook via HMAC-SHA256 (base64) against a shared secret.
 *   2. Persists new bookings and cancellations to a Postgres-backed store (Supabase).
 *   3. Suppresses any "nurture"/drip email sequences for an invitee once they book,
 *      by removing configured trigger tags from the email-marketing provider.
 *   4. Sends an internal notification email to an administrator.
 *
 * The email-marketing (nurture) integration and the transactional email sender are
 * both generalized behind small, provider-agnostic interfaces so this component can
 * be reused with different vendors. Sensible defaults are wired to Resend
 * (transactional) and a Kit-style REST API (nurture), both fully env-driven.
 *
 * Required / optional environment variables (NO real values — configure at deploy):
 *   WEBHOOK_SIGNING_SECRET       Shared secret for Calendly HMAC-SHA256 verification.
 *                                If unset, signature verification is SKIPPED (dev only).
 *   SUPABASE_URL                 Base URL of the Supabase project (persistence).
 *   SUPABASE_SERVICE_ROLE_KEY    Server-side service-role key (persistence). Never expose client-side.
 *   EMAIL_API_KEY                API key for the transactional email provider (Resend by default).
 *   EMAIL_FROM                   "From" address/identity for notification emails.
 *   ADMIN_EMAIL                  Recipient of booking/cancellation notifications.
 *   NURTURE_API_KEY              API key for the email-marketing/nurture provider (optional).
 *   NURTURE_API_BASE_URL         Base URL of the nurture provider REST API (optional).
 *   NURTURE_TAG_PREFIX           Tag prefix identifying nurture-sequence trigger tags to remove.
 *   PUBLIC_SITE_URL              Public site URL used to build the admin-dashboard link in emails.
 *   BOOKINGS_TABLE               Persistence table name for bookings (default "bookings").
 *
 * Key dependencies:
 *   - crypto (Node stdlib): HMAC-SHA256 signature verification.
 *   - @supabase/supabase-js: booking persistence (optional — no-op if not configured).
 *   - resend: default transactional email adapter (optional — no-op if not configured).
 *
 * Note: Adapted and generalized from a production codebase.
 *   Security & ordering constraints, do not reorder casually:
 *   1. Signature verification MUST run and pass BEFORE the body is parsed/trusted.
 *   2. Persistence, nurture-suppression, and email are all best-effort AFTER a verified
 *      booking — each failure is logged and swallowed so Calendly still receives a 200
 *      (Calendly retries non-2xx, which would duplicate side effects). Do not let a
 *      downstream failure bubble into a non-2xx response for an already-accepted event.
 *   3. verifyWebhookSignature returns true when no secret is configured — intentional
 *      dev escape hatch. In production WEBHOOK_SIGNING_SECRET MUST be set.
 */

'use strict';

const crypto = require('crypto');

// Note: Vendor SDKs are optional at runtime. We require lazily / guard on presence
// so the module can be unit-tested and reused without every provider installed.
// Original private imports were direct top-level requires; kept optional here.
let Resend;
try {
  ({ Resend } = require('resend'));
} catch {
  Resend = null;
}

let createSupabaseClient;
try {
  ({ createClient: createSupabaseClient } = require('@supabase/supabase-js'));
} catch {
  createSupabaseClient = null;
}

/**
 * @typedef {Object} BookingRecord
 * @property {string} [calendly_event_id]
 * @property {string} event_type
 * @property {string} name
 * @property {string} email
 * @property {string|null} phone
 * @property {string|null} start_time  ISO 8601 timestamp.
 * @property {string|null} end_time    ISO 8601 timestamp.
 * @property {string|null} location
 * @property {string} status
 * @property {string} source
 * @property {string|null} utm_source
 * @property {string|null} utm_medium
 * @property {string|null} utm_campaign
 * @property {Object} metadata         Raw Calendly payload, retained for audit.
 */

/**
 * @typedef {Object} EmailMessage
 * @property {string} from
 * @property {string} to
 * @property {string} subject
 * @property {string} html
 */

/**
 * Minimal transactional-email sender interface.
 * @typedef {Object} EmailSender
 * @property {(msg: EmailMessage) => Promise<unknown>} send  Sends one email; rejects on failure.
 */

/**
 * Minimal nurture / email-marketing suppression interface.
 * @typedef {Object} NurtureClient
 * @property {(email: string) => Promise<void>} suppress
 *   Removes nurture trigger tags for the given subscriber; must be a no-op if unknown.
 */

/**
 * @typedef {Object} HandlerConfig
 * @property {string} signingSecret
 * @property {string} bookingsTable
 * @property {string} emailFrom
 * @property {string} adminEmail
 * @property {string} publicSiteUrl
 * @property {import('@supabase/supabase-js').SupabaseClient|null} supabase
 * @property {EmailSender|null} emailSender
 * @property {NurtureClient|null} nurtureClient
 */

/**
 * Netlify-style event shape (only the fields this handler consumes).
 * @typedef {Object} NetlifyEvent
 * @property {string} httpMethod
 * @property {string} body               Raw request body (required intact for HMAC).
 * @property {Record<string,string>} headers
 */

/**
 * @typedef {Object} NetlifyResponse
 * @property {number} statusCode
 * @property {string} body
 */

/**
 * Verify a Calendly webhook signature using HMAC-SHA256 (base64), constant-time compared.
 *
 * Note: When no secret is configured this returns true (skip verification) — a
 * deliberate dev escape hatch. Never rely on that in production. Comparison uses
 * timingSafeEqual to avoid leaking the secret via response-timing side channels.
 *
 * NOTE (security fix): A configured secret with a MISSING signature must FAIL,
 * not skip. The previous `!secret || !signature` short-circuit let an attacker bypass
 * verification entirely by simply omitting the signature header while a secret was set.
 *
 * @param {string} payload    Raw, unparsed request body — must be the exact bytes signed.
 * @param {string} signature  Signature from the inbound request header.
 * @param {string} secret     Shared signing secret.
 * @returns {boolean} True if the signature is valid (or verification is skipped for lack of secret).
 */
function verifyWebhookSignature(payload, signature, secret) {
  if (!secret) return true; // No secret configured: skip verification (dev escape hatch only).
  if (!signature) return false; // Secret is set but no signature was sent: reject, never skip.

  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64');

  // Constant-time compare; length guard avoids timingSafeEqual throwing on mismatched sizes.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Build a booking record from a Calendly `invitee.created` payload.
 * @param {Object} eventPayload  The `payload` object of the Calendly webhook.
 * @returns {BookingRecord}
 */
function toBookingRecord(eventPayload) {
  const invitee = eventPayload.invitee || {};
  const calendlyEvent = eventPayload.event || {};
  const tracking = eventPayload.tracking || {};

  return {
    calendly_event_id: calendlyEvent.uri || invitee.uri,
    event_type: calendlyEvent.name || 'Consultation',
    name: invitee.name || '',
    email: invitee.email || '',
    phone: invitee.phone_number || null,
    start_time: calendlyEvent.start_time || null,
    end_time: calendlyEvent.end_time || null,
    location: (calendlyEvent.location && calendlyEvent.location.location) || null,
    status: 'scheduled',
    source: 'calendly',
    utm_source: tracking.utm_source || null,
    utm_medium: tracking.utm_medium || null,
    utm_campaign: tracking.utm_campaign || null,
    metadata: eventPayload,
  };
}

/**
 * Escape a value for safe interpolation into HTML.
 *
 * Note: Invitee-controlled fields (name, email, phone, UTM params) flow straight
 * from the webhook into notification email HTML. Without escaping, a crafted invitee
 * name could inject markup/script into the admin's inbox. Escape at every interpolation.
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

/**
 * Render the internal booking-notification email body.
 * @param {BookingRecord} booking
 * @param {string} publicSiteUrl  Base URL used to build the admin dashboard link.
 * @returns {string} HTML string.
 */
function formatBookingEmail(booking, publicSiteUrl) {
  const durationMinutes =
    booking.start_time && booking.end_time
      ? `${Math.round((new Date(booking.end_time).getTime() - new Date(booking.start_time).getTime()) / 60000)} minutes`
      : 'N/A';

  const startTime = booking.start_time
    ? new Date(booking.start_time).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })
    : 'N/A';

  const hasUtm = booking.utm_source || booking.utm_medium || booking.utm_campaign;

  return `
    <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #111;">
      <h2 style="margin: 0 0 12px; color: #EA580C;">New Consultation Booked!</h2>

      <div style="background: #FFF7ED; border-left: 4px solid #EA580C; padding: 20px; margin: 20px 0; border-radius: 8px;">
        <h3 style="margin-top: 0;">Contact Details</h3>
        <p><strong>Name:</strong> ${escapeHtml(booking.name)}</p>
        <p><strong>Email:</strong> ${escapeHtml(booking.email)}</p>
        ${booking.phone ? `<p><strong>Phone:</strong> ${escapeHtml(booking.phone)}</p>` : ''}
      </div>

      <div style="background: #F0F9FF; padding: 20px; margin: 20px 0; border-radius: 8px;">
        <h3 style="margin-top: 0;">Appointment Details</h3>
        <p><strong>Event Type:</strong> ${escapeHtml(booking.event_type || 'Consultation')}</p>
        <p><strong>Start Time:</strong> ${escapeHtml(startTime)}</p>
        <p><strong>Duration:</strong> ${escapeHtml(durationMinutes)}</p>
        ${booking.location ? `<p><strong>Location:</strong> ${escapeHtml(booking.location)}</p>` : ''}
      </div>

      ${hasUtm ? `
        <div style="background: #F9FAFB; padding: 20px; margin: 20px 0; border-radius: 8px;">
          <h3 style="margin-top: 0;">Marketing Source</h3>
          ${booking.utm_source ? `<p><strong>Source:</strong> ${escapeHtml(booking.utm_source)}</p>` : ''}
          ${booking.utm_medium ? `<p><strong>Medium:</strong> ${escapeHtml(booking.utm_medium)}</p>` : ''}
          ${booking.utm_campaign ? `<p><strong>Campaign:</strong> ${escapeHtml(booking.utm_campaign)}</p>` : ''}
        </div>
      ` : ''}

      <p style="color: #6B7280; font-size: 14px; margin-top: 30px;">
        View all bookings in your <a href="${publicSiteUrl}/admin/bookings" style="color: #EA580C;">admin dashboard</a>.
      </p>
    </div>
  `;
}

/**
 * Build a Supabase persistence client from the environment, or null if unconfigured.
 * @returns {import('@supabase/supabase-js').SupabaseClient|null}
 */
function buildSupabaseClient() {
  const url = process.env.SUPABASE_URL || '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !serviceKey || !createSupabaseClient) return null;

  return createSupabaseClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Build the default Resend-backed transactional email sender, or null if unconfigured.
 * @returns {EmailSender|null}
 */
function buildDefaultEmailSender() {
  const apiKey = process.env.EMAIL_API_KEY || '';
  if (!apiKey || !Resend) return null;

  const resend = new Resend(apiKey);
  return {
    send: (msg) => resend.emails.send(msg),
  };
}

/**
 * Build the default Kit-style nurture-suppression client, or null if unconfigured.
 *
 * Suppression removes every tag whose name starts with NURTURE_TAG_PREFIX from the
 * matched subscriber, so the marketing provider stops advancing them through drip/sales
 * sequences once they have booked. If the subscriber is unknown (booked without ever
 * entering the funnel) it silently no-ops.
 *
 * Note: Generalized from a specific vendor. The REST shape (v4 subscribers/tags,
 * Bearer auth) matches Kit/ConvertKit-style APIs; point NURTURE_API_BASE_URL at your
 * provider. Errors are non-fatal by contract — booking side effects must never be
 * blocked by a marketing-tool outage.
 *
 * @returns {NurtureClient|null}
 */
function buildDefaultNurtureClient() {
  const apiKey = process.env.NURTURE_API_KEY || '';
  const baseUrl = (process.env.NURTURE_API_BASE_URL || '').replace(/\/+$/, '');
  const tagPrefix = process.env.NURTURE_TAG_PREFIX || '';
  if (!apiKey || !baseUrl) return null;

  const authHeaders = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

  return {
    async suppress(email) {
      if (!email) return;
      try {
        // Step 1: find subscriber by email.
        const searchRes = await fetch(
          `${baseUrl}/subscribers?email_address=${encodeURIComponent(email)}`,
          { headers: authHeaders },
        );
        if (!searchRes.ok) return;
        const searchData = await searchRes.json();
        const subscriber = searchData.subscribers && searchData.subscribers[0];
        if (!subscriber) {
          console.log(`Nurture suppression: no subscriber found for ${email} — skipping`);
          return;
        }

        // Step 2: list the subscriber's tags.
        const tagsRes = await fetch(`${baseUrl}/subscribers/${subscriber.id}/tags`, {
          headers: authHeaders,
        });
        if (!tagsRes.ok) return;
        const tagsData = await tagsRes.json();

        // Remove ALL tags matching the configured prefix — covers current and future sequences.
        const matchingTags = (tagsData.tags || []).filter(
          (t) => t.name && (!tagPrefix || t.name.startsWith(tagPrefix)),
        );

        // Step 3: remove each matching tag.
        for (const tag of matchingTags) {
          await fetch(`${baseUrl}/subscribers/${subscriber.id}/tags/${tag.id}`, {
            method: 'DELETE',
            headers: authHeaders,
          });
          console.log(`Nurture suppression: removed tag '${tag.name}' from ${email}`);
        }
      } catch (err) {
        console.error('Nurture suppression error (non-fatal):', err);
      }
    },
  };
}

/**
 * Resolve handler configuration from the environment, allowing overrides for testing/DI.
 * @param {Partial<HandlerConfig>} [overrides]
 * @returns {HandlerConfig}
 */
function resolveConfig(overrides = {}) {
  return {
    signingSecret: overrides.signingSecret ?? (process.env.WEBHOOK_SIGNING_SECRET || ''),
    bookingsTable: overrides.bookingsTable ?? (process.env.BOOKINGS_TABLE || 'bookings'),
    emailFrom: overrides.emailFrom ?? (process.env.EMAIL_FROM || 'Example Co <no-reply@example.com>'),
    adminEmail: overrides.adminEmail ?? (process.env.ADMIN_EMAIL || 'admin@example.com'),
    publicSiteUrl: overrides.publicSiteUrl ?? (process.env.PUBLIC_SITE_URL || 'https://example.com'),
    supabase: overrides.supabase ?? buildSupabaseClient(),
    emailSender: overrides.emailSender ?? buildDefaultEmailSender(),
    nurtureClient: overrides.nurtureClient ?? buildDefaultNurtureClient(),
  };
}

/**
 * Handle a verified `invitee.created` event: persist, suppress nurture, notify admin.
 * @param {Object} eventPayload
 * @param {HandlerConfig} config
 * @returns {Promise<void>}
 */
async function handleInviteeCreated(eventPayload, config) {
  const booking = toBookingRecord(eventPayload);

  // Persist (best-effort).
  if (config.supabase) {
    try {
      const { error } = await config.supabase.from(config.bookingsTable).insert(booking);
      if (error) console.error('Failed saving booking:', error);
      else console.log('Booking saved successfully');
    } catch (dbErr) {
      console.error('Exception saving booking:', dbErr);
    }
  }

  // Suppress nurture sequences for the now-booked invitee (best-effort, self-swallowing).
  if (config.nurtureClient) {
    await config.nurtureClient.suppress(booking.email);
  }

  // Notify admin (best-effort).
  if (config.emailSender) {
    try {
      await config.emailSender.send({
        from: config.emailFrom,
        to: config.adminEmail,
        subject: `New Consultation Booked: ${booking.name}`,
        html: formatBookingEmail(booking, config.publicSiteUrl),
      });
      console.log('Booking notification email sent');
    } catch (emailErr) {
      console.error('Failed sending booking notification:', emailErr);
    }
  }
}

/**
 * Handle a verified `invitee.canceled` event: mark cancelled, notify admin.
 * @param {Object} eventPayload
 * @param {HandlerConfig} config
 * @returns {Promise<void>}
 */
async function handleInviteeCanceled(eventPayload, config) {
  const invitee = eventPayload.invitee || {};
  const cancellation = eventPayload.cancellation || {};
  // Note: URI precedence MUST match toBookingRecord's calendly_event_id
  // (event.uri first, invitee.uri fallback). If these disagree, the cancel UPDATE
  // matches zero rows and the booking is silently never marked cancelled.
  const eventUri = (eventPayload.event && eventPayload.event.uri) || invitee.uri || null;
  const reason = cancellation.reason || 'No reason provided';

  if (config.supabase && eventUri) {
    try {
      await config.supabase
        .from(config.bookingsTable)
        .update({ status: 'cancelled', cancellation_reason: reason })
        .eq('calendly_event_id', eventUri);
      console.log('Booking marked as cancelled');
    } catch (dbErr) {
      console.error('Failed updating cancelled booking:', dbErr);
    }
  } else if (config.supabase) {
    // No usable identifier to target the row — log rather than issue an unfiltered update.
    console.error('Cancellation received without a resolvable calendly_event_id; skipping update');
  }

  if (config.emailSender) {
    try {
      await config.emailSender.send({
        from: config.emailFrom,
        to: config.adminEmail,
        subject: `Consultation Cancelled: ${invitee.name}`,
        html: `
          <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #111;">
            <h2 style="color: #DC2626;">Consultation Cancelled</h2>
            <p><strong>Name:</strong> ${escapeHtml(invitee.name)}</p>
            <p><strong>Email:</strong> ${escapeHtml(invitee.email)}</p>
            <p><strong>Reason:</strong> ${escapeHtml(reason)}</p>
          </div>
        `,
      });
    } catch (emailErr) {
      console.error('Failed sending cancellation notification:', emailErr);
    }
  }
}

/**
 * Create a Calendly webhook handler bound to the given config (env-derived by default).
 * Exposed as a factory to allow dependency injection in tests without env coupling.
 *
 * @param {Partial<HandlerConfig>} [overrides]
 * @returns {(event: NetlifyEvent) => Promise<NetlifyResponse>}
 */
function createHandler(overrides = {}) {
  const config = resolveConfig(overrides);

  /**
   * @param {NetlifyEvent} event
   * @returns {Promise<NetlifyResponse>}
   */
  return async function handler(event) {
    // Only accept POST requests.
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    try {
      const payload = event.body;
      const signature = (event.headers && event.headers['calendly-webhook-signature']) || '';

      // Note: Verify BEFORE parsing/trusting the body. HMAC is computed over the raw
      // body bytes, so `event.body` must be the untouched string Calendly signed.
      if (config.signingSecret && !verifyWebhookSignature(payload, signature, config.signingSecret)) {
        console.error('Invalid webhook signature');
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid signature' }) };
      }

      const webhookData = JSON.parse(payload);
      console.log('Received Calendly webhook:', webhookData.event);

      const eventType = webhookData.event;
      const eventPayload = webhookData.payload || {};

      if (eventType === 'invitee.created') {
        await handleInviteeCreated(eventPayload, config);
      } else if (eventType === 'invitee.canceled') {
        await handleInviteeCanceled(eventPayload, config);
      }

      // Always 200 on a verified, well-formed event so Calendly does not retry and
      // duplicate the best-effort side effects above.
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    } catch (err) {
      console.error('Calendly webhook error:', err);
      return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
    }
  };
}

// Default Netlify entry point — handler bound to environment-derived config.
const handler = createHandler();

module.exports = {
  handler,
  createHandler,
  // Exposed for unit testing / reuse.
  verifyWebhookSignature,
  toBookingRecord,
  formatBookingEmail,
  escapeHtml,
  resolveConfig,
};
