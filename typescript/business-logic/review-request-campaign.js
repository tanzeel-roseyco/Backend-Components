/**
 * Review Request Campaign — post-booking review workflow.
 *
 * Adapted and generalized from a production codebase.
 *
 * Sends review-request emails to customers whose bookings are completed and
 * past a configurable "cooling off" delay window. Chooses the target review
 * platform (e.g. Google Business Profile vs. a social page) based on the
 * booking's location, and rate-limits how many emails are sent per invocation
 * to avoid tripping review-platform spam detection.
 *
 * Designed as a serverless HTTP handler (Netlify Functions / AWS Lambda proxy
 * shape) but the core `runReviewCampaign` logic is transport-agnostic and can
 * be called directly.
 *
 * Required environment variables:
 *   - EMAIL_API_KEY            API key for the transactional email provider (Resend).
 *   - DB_URL                   Base URL of the backend database service (Supabase).
 *   - DB_SERVICE_ROLE_KEY      Service-role key for server-side DB access (Supabase).
 *   - CONTACT_FROM_EMAIL       "From" address/name for outgoing mail, e.g. "Example Co <noreply@example.com>".
 *   - SOCIAL_REVIEW_URL        Review URL used for online-only / service-area locations.
 *   - CAMPAIGN_AUTH_TOKEN      Shared secret required in the HTTP handler's Authorization
 *                              header ("Bearer <token>") to authorize triggering a send.
 *
 * Key dependencies:
 *   - resend                   Transactional email SDK.
 *   - @supabase/supabase-js    Postgres-backed data service client.
 *
 * Expected `bookings` table columns:
 *   id, name, email, location, status, created_at,
 *   review_request_sent (bool), review_request_sent_at (timestamptz)
 *
 * AIDEV-NOTE: Ordering/security constraints —
 *   1. Only completed bookings older than the delay window are eligible; the
 *      delay both respects platform review-timing policy and gives the customer
 *      time to feel the service outcome.
 *   2. `review_request_sent` MUST be flipped true only AFTER a successful send,
 *      and the DB read filters on it being false — this is the idempotency guard
 *      that prevents re-emailing the same customer on retries/re-runs.
 *   3. The per-call `maxPerRun` cap is a deliberate rate limit, not a paging
 *      convenience; do not remove it to "send everything at once".
 *   4. Secrets come only from env vars; never inline keys. This module is public.
 */

'use strict';

const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');

/**
 * Escape a string for safe interpolation into HTML text/attribute contexts.
 * Booking-derived fields (customer name, location) originate outside this system
 * and are rendered into the email body, so they must be escaped to prevent HTML
 * injection into the outgoing message.
 *
 * @param {unknown} value
 * @returns {string}
 */
const escapeHtml = (value) =>
  String(value == null ? '' : value).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])
  );

/**
 * Validate that a URL is an http(s) link safe to place in an href. Guards against
 * `javascript:` and other unexpected schemes leaking into the email from config.
 *
 * @param {string} url
 * @returns {boolean}
 */
const isSafeHttpUrl = (url) => /^https?:\/\//i.test(url || '');

// --- Environment-backed secrets (never hardcode real values) -----------------

const EMAIL_API_KEY = process.env.EMAIL_API_KEY || '';
const emailClient = EMAIL_API_KEY ? new Resend(EMAIL_API_KEY) : null;

/**
 * Lazily build a service-role database client for server-side operations.
 * Returns null when the required env vars are absent so callers can fail loud.
 *
 * @returns {import('@supabase/supabase-js').SupabaseClient | null}
 */
const getDbClient = () => {
  const dbUrl = process.env.DB_URL || '';
  const dbServiceKey = process.env.DB_SERVICE_ROLE_KEY || '';

  if (!dbUrl || !dbServiceKey) {
    return null;
  }

  return createClient(dbUrl, dbServiceKey, {
    // Service-role usage: no session persistence or token refresh on the server.
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
};

// --- Default campaign configuration (all values are neutral placeholders) ----

/**
 * @typedef {'google' | 'social'} ReviewPlatform
 */

/**
 * @typedef {Object} CampaignConfig
 * @property {number} delayDays           Minimum age (in days) of a completed booking before it is eligible.
 * @property {number} maxPerRun           Hard cap on emails sent per invocation (rate limit / spam-safety).
 * @property {string} defaultLocationKey  Fallback key into `reviewLinksByLocation` when a booking's location is unknown.
 * @property {Record<string, string>} reviewLinksByLocation  Map of physical-location name -> platform review URL.
 * @property {string[]} serviceAreaCities Locations treated as online-only; routed to the social review URL.
 * @property {string} socialReviewUrl     Review URL used for service-area / online-only locations.
 * @property {string} fromEmail           "From" header for outgoing mail.
 * @property {string} subject             Email subject line.
 * @property {(ctx: EmailTemplateContext) => string} template  HTML template renderer.
 */

/**
 * @typedef {Object} EmailTemplateContext
 * @property {string} firstName
 * @property {string} location
 * @property {string} reviewUrl
 * @property {ReviewPlatform} platform
 */

/**
 * AIDEV-NOTE: Location data below is illustrative only. Real deployments should
 * pass their own `reviewLinksByLocation` / `serviceAreaCities` via config or env.
 * The two-tier routing (physical clinic -> Google link, service-area city ->
 * social page) is the real generalized logic that was borrowed.
 */
const DEFAULT_REVIEW_LINKS_BY_LOCATION = {
  // Physical location(s): direct customers to the Google Business Profile review form.
  // Format hint: https://g.page/r/{PLACE_ID}/review
  'Example City': 'https://example.com/review',
};

const DEFAULT_SERVICE_AREA_CITIES = [
  // Online-only service areas with no physical presence -> routed to the social page.
  'Example Town A',
  'Example Town B',
];

/**
 * Default HTML email template with platform-specific messaging.
 * All identity is neutral; customize per deployment.
 *
 * @param {EmailTemplateContext} ctx
 * @returns {string} Rendered HTML email body.
 */
const defaultEmailTemplate = ({ firstName, location, reviewUrl, platform }) => {
  const platformText =
    platform === 'social'
      ? 'sharing your experience on our social page'
      : 'sharing your experience on Google';

  // Escape booking-derived fields; reviewUrl is config-controlled but still
  // scheme-validated to keep only http(s) links in the CTA href.
  const safeFirstName = escapeHtml(firstName);
  const safeLocation = escapeHtml(location);
  const safeReviewUrl = isSafeHttpUrl(reviewUrl) ? reviewUrl : '#';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <p>Hi ${safeFirstName},</p>

  <p>I hope you're feeling the benefits from your recent session${safeLocation ? ' in ' + safeLocation : ''}.</p>

  <p>I'd really value your feedback. If you have a moment, would you mind ${platformText}?</p>

  <div style="text-align: center; margin: 30px 0;">
    <a href="${safeReviewUrl}" style="background-color: #8B7355; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">Leave a Review</a>
  </div>

  <p>Your honest feedback helps others find the support they need. Thank you!</p>

  <p>Warm regards,<br>
  The Example Co Team</p>

  <hr style="margin-top: 30px; border: none; border-top: 1px solid #ddd;">
  <p style="font-size: 12px; color: #666;">
    Example Co<br>
    <a href="https://example.com">www.example.com</a>
  </p>
</body>
</html>`;
};

/**
 * Build the effective campaign config by layering caller overrides over defaults
 * and env-backed values. Kept pure so it is trivially testable.
 *
 * @param {Partial<CampaignConfig>} [overrides]
 * @returns {CampaignConfig}
 */
const buildConfig = (overrides = {}) => ({
  delayDays: 7, // Delay window: age a completed booking must exceed to be eligible.
  maxPerRun: 10, // Rate limit: max emails per invocation (spam-detection safety).
  defaultLocationKey: 'Example City',
  reviewLinksByLocation: DEFAULT_REVIEW_LINKS_BY_LOCATION,
  serviceAreaCities: DEFAULT_SERVICE_AREA_CITIES,
  socialReviewUrl: process.env.SOCIAL_REVIEW_URL || '',
  fromEmail: process.env.CONTACT_FROM_EMAIL || 'Example Co <noreply@example.com>',
  subject: 'How was your recent session?',
  template: defaultEmailTemplate,
  ...overrides,
});

// --- Core campaign logic (transport-agnostic) --------------------------------

/**
 * @typedef {Object} CampaignResult
 * @property {number} sent
 * @property {number} skipped
 * @property {Array<{ bookingId?: string, email?: string, error: string }>} errors
 */

/**
 * Resolve the review platform + URL for a given booking location.
 * Service-area (online-only) locations route to the social page; everything
 * else uses the per-location Google review link (falling back to the default).
 *
 * @param {string | null | undefined} location
 * @param {CampaignConfig} config
 * @returns {{ platform: ReviewPlatform, reviewUrl: string }}
 */
const resolvePlatform = (location, config) => {
  const isServiceAreaCity =
    !!location && config.serviceAreaCities.some((city) => location.includes(city));

  if (isServiceAreaCity) {
    return { platform: 'social', reviewUrl: config.socialReviewUrl };
  }

  const reviewUrl =
    (location && config.reviewLinksByLocation[location]) ||
    config.reviewLinksByLocation[config.defaultLocationKey] ||
    '';

  return { platform: 'google', reviewUrl };
};

/**
 * Run the review-request campaign against eligible bookings.
 *
 * @param {Object} params
 * @param {string[] | 'all-eligible'} params.bookingIds  Specific IDs to target, or the sentinel 'all-eligible'.
 * @param {Partial<CampaignConfig>} [params.config]       Optional config overrides.
 * @returns {Promise<CampaignResult>}
 * @throws {Error} When the email or database service is not configured.
 */
const runReviewCampaign = async ({ bookingIds, config: overrides }) => {
  const config = buildConfig(overrides);

  // Fail loud when required external services are missing rather than silently no-op.
  if (!EMAIL_API_KEY || !emailClient) {
    throw new Error('Email service not configured');
  }

  const db = getDbClient();
  if (!db) {
    throw new Error('Database not configured');
  }

  /** @type {CampaignResult} */
  const results = { sent: 0, skipped: 0, errors: [] };

  // Targeting: the 'all-eligible' sentinel means "every eligible booking";
  // otherwise an explicit array of IDs is required. An empty array targets
  // nothing (short-circuit) — it must NOT silently fall through to all-eligible.
  const targetsAll = bookingIds === 'all-eligible';
  if (!targetsAll && (!Array.isArray(bookingIds) || bookingIds.length === 0)) {
    return results;
  }

  // Eligibility threshold: only bookings completed before this instant qualify.
  const thresholdIso = new Date(
    Date.now() - config.delayDays * 24 * 60 * 60 * 1000
  ).toISOString();

  let query = db
    .from('bookings')
    .select('*')
    .eq('status', 'completed')
    .eq('review_request_sent', false) // idempotency guard: never re-target a booking already sent to.
    .lt('created_at', thresholdIso);

  // Narrow to explicit IDs unless the caller asked for all eligible bookings.
  if (!targetsAll) {
    query = query.in('id', bookingIds);
  }

  // AIDEV-NOTE: Deliberate rate limit — caps blast radius per run to stay under
  // review-platform spam thresholds. Do not remove.
  query = query.limit(config.maxPerRun);

  const { data: eligibleBookings, error: fetchError } = await query;

  if (fetchError) {
    // Propagate as a thrown error so the transport layer maps it to a 5xx.
    throw new Error(`Failed to fetch bookings: ${fetchError.message || 'unknown error'}`);
  }

  if (!eligibleBookings || eligibleBookings.length === 0) {
    return results;
  }

  for (const booking of eligibleBookings) {
    try {
      // Personalize with the first token of the stored name; tolerate blanks.
      const firstName = (booking.name || '').split(' ')[0] || 'there';

      const { platform, reviewUrl } = resolvePlatform(booking.location, config);

      // Skip rather than send a review email with a missing/blank link — an
      // unresolved location or unconfigured SOCIAL_REVIEW_URL would otherwise
      // dispatch a broken CTA. Counted as skipped, not sent, and never flagged.
      if (!reviewUrl) {
        results.skipped++;
        continue;
      }

      await emailClient.emails.send({
        from: config.fromEmail,
        to: booking.email,
        subject: config.subject,
        html: config.template({
          firstName,
          location: booking.location || '',
          reviewUrl,
          platform,
        }),
      });

      // Mark as sent ONLY after a successful send — preserves idempotency.
      const { error: updateError } = await db
        .from('bookings')
        .update({
          review_request_sent: true,
          review_request_sent_at: new Date().toISOString(),
        })
        .eq('id', booking.id);

      if (updateError) {
        // Email went out but the flag didn't flip: surface it so it can be
        // reconciled. A retry may double-send — accept that tradeoff over
        // silently losing the record.
        console.error(`Failed to update booking ${booking.id}:`, updateError);
        results.errors.push({ bookingId: booking.id, error: 'Failed to update database' });
      } else {
        results.sent++;
      }
    } catch (err) {
      console.error(`Error sending to ${booking.email}:`, err);
      results.errors.push({
        bookingId: booking.id,
        email: booking.email,
        error: err instanceof Error ? err.message : 'Failed to send email',
      });
    }
  }

  return results;
};

// --- Serverless HTTP handler -------------------------------------------------

/**
 * Netlify/Lambda-style HTTP entrypoint. Validates the request, delegates to
 * `runReviewCampaign`, and maps outcomes to HTTP status codes.
 *
 * @param {{ httpMethod?: string, headers?: Record<string, string>, body?: string | null }} event
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // AIDEV-NOTE: Authorization is enforced here (not in runReviewCampaign) so the
  // core logic stays transport-agnostic. This endpoint sends real customer email,
  // so it must never be publicly triggerable. Fail closed: if the shared secret
  // is unset, treat the endpoint as misconfigured rather than open.
  const expectedToken = process.env.CAMPAIGN_AUTH_TOKEN || '';
  if (!expectedToken) {
    console.error('CAMPAIGN_AUTH_TOKEN is not configured; refusing to run.');
    return { statusCode: 500, body: JSON.stringify({ error: 'Server not configured' }) };
  }
  const headers = event.headers || {};
  // Header names are case-insensitive; normalize before reading Authorization.
  const authHeader =
    headers.authorization ||
    headers.Authorization ||
    Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1] ||
    '';
  const presented = authHeader.replace(/^Bearer\s+/i, '');
  if (presented !== expectedToken) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { bookingIds } = body;

    // Validate at the boundary: accept an array of IDs or the 'all-eligible' sentinel.
    if (!bookingIds || (bookingIds !== 'all-eligible' && !Array.isArray(bookingIds))) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'bookingIds must be an array or "all-eligible"' }),
      };
    }

    const results = await runReviewCampaign({ bookingIds });
    return { statusCode: 200, body: JSON.stringify(results) };
  } catch (err) {
    // Configuration errors and DB fetch failures land here as 500s.
    console.error('Review request function error:', err);
    const message = err instanceof Error ? err.message : 'Internal error';
    return { statusCode: 500, body: JSON.stringify({ error: message }) };
  }
};

module.exports = {
  handler,
  runReviewCampaign,
  resolvePlatform,
  buildConfig,
  defaultEmailTemplate,
};
