/**
 * Quiz Assessment Handler
 * ========================
 * Serverless (Netlify Functions style) HTTP handler that processes a quiz/assessment
 * submission and runs a three-stage pipeline:
 *
 *   1. Tiered tagging     — derives a deterministic marketing tag `quiz-<niche>-tier-<tier>`
 *                           server-side (the client is never trusted to supply the tag).
 *   2. Consent-tracked storage — persists the response (plus health-data consent flags and
 *                           consent timestamp) to a Postgres/Supabase table.
 *   3. Personalized email — emails a tier-based result to the submitter and a notification
 *                           to the practice inbox via a transactional email provider (Resend),
 *                           and upserts the contact into an ESP (Kit v4) with the derived tag.
 *
 * Adapted and generalized from a production codebase. All branding, contact details,
 * and copy are neutral placeholders driven by environment variables.
 *
 * Required / optional environment variables
 * ------------------------------------------
 *   RESEND_API_KEY              (optional) Transactional email provider key. Emails skipped if absent.
 *   KIT_API_KEY                 (optional) ESP (Kit v4) API key. ESP sync skipped if absent.
 *   SUPABASE_URL                (optional) Supabase project URL. Storage skipped if absent.
 *   SUPABASE_SERVICE_ROLE_KEY   (optional) Supabase service-role key (server-side only — never ship to client).
 *   CONTACT_FROM_EMAIL          (optional) "From" address for outbound email. Default: user@example.com.
 *   CONTACT_TO_EMAIL            (optional) Practice inbox for admin notifications. Default: user@example.com.
 *   BRAND_NAME                  (optional) Display brand shown in emails. Default: 'Example Co'.
 *   PRACTITIONER_NAME           (optional) Sign-off name shown in the result email. Default: 'The Team'.
 *   BOOKING_URL                 (optional) CTA link in the result email. Default: https://example.com/contact.
 *   CONTACT_PHONE               (optional) Contact phone shown in the result email. Default: '' (omitted if blank).
 *
 * Key dependencies
 * ----------------
 *   resend                  — transactional email sending
 *   @supabase/supabase-js   — persistence
 *   global fetch            — Kit v4 REST calls (Node 18+ / edge runtime)
 *
 * Note: Role = quiz intake pipeline edge function. Ordering & security constraints:
 *   - The Kit tag is ALWAYS constructed server-side from validated `niche`/`tier`; never accept a
 *     client-supplied tag (prevents tag-injection into the ESP).
 *   - Storage runs BEFORE email/ESP so a submission is never silently lost if a downstream provider
 *     fails; each side-effect (DB, ESP, email) is independently try/caught and NON-FATAL — a 200 is
 *     still returned as long as the request parsed and validated. This is deliberate: the submitter
 *     should not see an error just because a marketing side-effect degraded.
 *   - SUPABASE_SERVICE_ROLE_KEY bypasses row-level security — it must only ever exist server-side.
 *   - `consent_health_data` / `consent_timestamp` are persisted verbatim for GDPR special-category
 *     (health) data auditing; do not drop them.
 */

'use strict';

// Note: Providers are optional at module scope so the handler degrades gracefully when a
// given integration is not configured (e.g. preview deploys without live keys).
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const KIT_API_KEY = process.env.KIT_API_KEY || '';
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// Neutral branding defaults — override via env in production.
const BRAND_NAME = process.env.BRAND_NAME || 'Example Co';
const PRACTITIONER_NAME = process.env.PRACTITIONER_NAME || 'The Team';
const BOOKING_URL = process.env.BOOKING_URL || 'https://example.com/contact';
const CONTACT_PHONE = process.env.CONTACT_PHONE || '';
const FROM_EMAIL = process.env.CONTACT_FROM_EMAIL || `${BRAND_NAME} <user@example.com>`;
const TO_EMAIL = process.env.CONTACT_TO_EMAIL || 'user@example.com';

const KIT_API_BASE = 'https://api.kit.com/v4';

// Note: Tier labels map the numeric severity tier to human copy used in email subjects/bodies.
// Kept as a lookup (not nested conditionals) so adding tiers is a one-line change.
/** @type {Readonly<Record<number, string>>} */
const TIER_NAMES = Object.freeze({ 1: 'Mild', 2: 'Moderate', 3: 'Significant' });

/**
 * @typedef {Object} QuizSubmission
 * @property {string}  name                  Submitter's full name (required).
 * @property {string}  email                 Submitter's email address (required).
 * @property {string}  niche                 Quiz topic/segment slug, e.g. "sleep" (required).
 * @property {number}  tier                  Severity tier: 1, 2, or 3 (required).
 * @property {string=} quiz_slug             Specific quiz identifier; falls back to `niche`.
 * @property {boolean=} consent_health_data  Whether the submitter consented to health-data processing.
 * @property {string=} consent_timestamp     ISO-8601 timestamp of when consent was captured.
 */

/**
 * @typedef {Object} HttpEvent
 * @property {string}  httpMethod  HTTP method (only POST is accepted).
 * @property {?string} body        Raw JSON request body.
 */

/**
 * @typedef {Object} HttpResult
 * @property {number} statusCode
 * @property {string} body
 */

/**
 * Build a JSON HTTP response.
 * @param {number} statusCode
 * @param {Record<string, unknown>} payload
 * @returns {HttpResult}
 */
const jsonResponse = (statusCode, payload) => ({
  statusCode,
  body: JSON.stringify(payload),
});

/**
 * Normalize an arbitrary string into a lowercase, hyphen-delimited slug.
 * Note: `niche` is client-supplied and flows into the ESP tag name; slugifying here is what
 * actually makes the tag "server-controlled" (the header's claim). Prevents spaces/punctuation/
 * unicode in a submitted niche from producing a malformed or injected ESP tag.
 * @param {unknown} value
 * @returns {string}
 */
function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-') // collapse any run of non-alphanumerics to a single hyphen
    .replace(/^-+|-+$/g, '');    // trim leading/trailing hyphens
}

/**
 * Basic RFC-lite email shape check for boundary validation. Not a deliverability guarantee —
 * just rejects obviously malformed values before they reach the ESP / email provider.
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * Derive the deterministic, server-controlled ESP tag for a submission.
 * @param {string} niche
 * @param {number} tier
 * @returns {string} e.g. "quiz-sleep-tier-2"
 */
const buildTierTag = (niche, tier) => `quiz-${slugify(niche)}-tier-${tier}`;

/**
 * Render the submitter's tier-based result email (HTML).
 * @param {string} firstName
 * @param {string} tierName
 * @returns {string}
 */
const renderResultEmail = (firstName, tierName) => {
  // Note: Inline styles (not a stylesheet) because most email clients strip <style>/external CSS.
  const phoneLine = CONTACT_PHONE
    ? `<p style="color: #6B7280; font-size: 14px; margin-top: 24px;">Questions before we speak? Reply to this email or call ${escapeHtml(CONTACT_PHONE)}.</p>`
    : '';

  return `
    <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #111; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #F0F9FF 0%, #FEF3F2 100%); padding: 40px 20px; text-align: center; border-radius: 12px 12px 0 0;">
        <h1 style="margin: 0; color: #1F2937; font-size: 28px;">Your Personalised Plan</h1>
      </div>
      <div style="background: white; padding: 40px 30px; border-radius: 0 0 12px 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
        <p style="font-size: 18px; margin-top: 0;">Hi ${escapeHtml(firstName)},</p>
        <p>Your quiz result: <strong>${escapeHtml(tierName)}</strong></p>
        <p>Thank you for taking the quiz. ${escapeHtml(PRACTITIONER_NAME)} will be in touch shortly with your personalised plan.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${escapeHtml(BOOKING_URL)}" style="display: inline-block; background: #EA580C; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">Book Your Free Call</a>
        </div>
        ${phoneLine}
        <p style="color: #6B7280; font-size: 14px;">You can unsubscribe from these emails at any time.</p>
        <p style="margin-top: 24px; color: #1F2937; font-weight: 600;">${escapeHtml(PRACTITIONER_NAME)}</p>
        <p style="margin: 0; color: #9CA3AF; font-size: 12px;">${escapeHtml(BRAND_NAME)}</p>
      </div>
    </div>
  `;
};

/**
 * Render the internal admin-notification email (HTML).
 * @param {Object} params
 * @param {string} params.name
 * @param {string} params.email
 * @param {string} params.quizSlug
 * @param {number} params.tier
 * @param {string} params.tierName
 * @param {string} params.niche
 * @param {string} params.kitTag
 * @param {boolean} params.consentHealthData
 * @param {string} params.consentTimestamp
 * @returns {string}
 */
const renderAdminEmail = ({
  name, email, quizSlug, tier, tierName, niche, kitTag, consentHealthData, consentTimestamp,
}) => `
  <p><strong>Name:</strong> ${escapeHtml(name)}</p>
  <p><strong>Email:</strong> ${escapeHtml(email)}</p>
  <p><strong>Quiz:</strong> ${escapeHtml(quizSlug || niche)}</p>
  <p><strong>Tier:</strong> ${escapeHtml(tierName)} (${tier})</p>
  <p><strong>ESP Tag:</strong> ${escapeHtml(kitTag)}</p>
  <p><strong>Consent — Health Data:</strong> ${consentHealthData ? 'Yes' : 'No'}</p>
  <p><strong>Consent Timestamp:</strong> ${escapeHtml(consentTimestamp || 'not provided')}</p>
`;

/**
 * Minimal HTML-entity escaper for user-supplied values interpolated into email markup.
 * Note: Submissions are untrusted external input; escape before embedding in HTML to avoid
 * broken markup / injected content in the practice inbox. Not a full sanitizer — sufficient for
 * text nodes and attribute values used here.
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Lazily construct a server-side Supabase client.
 * @returns {import('@supabase/supabase-js').SupabaseClient | null} null when not configured.
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
 * Persist the submission with consent tracking. Non-fatal on failure.
 * @param {QuizSubmission} data
 * @param {string} kitTag
 * @returns {Promise<void>}
 */
async function storeSubmission(data, kitTag) {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  try {
    // Note: consent_* columns capture GDPR special-category (health) consent — persisted
    // verbatim for auditability. `status`/`source` support downstream triage of leads.
    await supabase.from('quiz_responses').insert({
      name: data.name,
      email: data.email,
      quiz_slug: data.quiz_slug || data.niche,
      niche: data.niche || null,
      tier: data.tier || null,
      kit_tag: kitTag,
      consent_health_data: data.consent_health_data || false,
      consent_timestamp: data.consent_timestamp || null,
      status: 'new',
      source: 'quiz-landing',
    });
  } catch (dbErr) {
    console.error('Failed saving quiz response to storage', dbErr);
    // Continue with email and ESP flow even if DB fails.
  }
}

/**
 * Upsert the contact into the ESP (Kit v4) and apply the tier tag. Non-fatal on failure.
 * Two-step flow: create/upsert subscriber → apply tag by name.
 * @param {QuizSubmission} data
 * @param {string} kitTag
 * @returns {Promise<void>}
 */
async function syncToEsp(data, kitTag) {
  if (!KIT_API_KEY) {
    console.log('KIT_API_KEY not configured — skipping ESP integration');
    return;
  }

  /** @type {Record<string, string>} */
  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${KIT_API_KEY}`,
  };

  try {
    // Step 1: create or upsert subscriber.
    const subscriberResponse = await fetch(`${KIT_API_BASE}/subscribers`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        email_address: data.email,
        first_name: data.name || undefined,
        fields: {},
      }),
    });

    if (!subscriberResponse.ok) {
      const subError = await subscriberResponse.json().catch(() => ({}));
      console.error('ESP subscriber creation failed:', subscriberResponse.status, subError);
      return;
    }

    const subscriberData = await subscriberResponse.json();
    const subscriberId = subscriberData.subscriber?.id || subscriberData.id;
    if (!subscriberId) {
      console.error('ESP subscriber ID missing from response', subscriberData);
      return;
    }

    // Step 2: apply the server-derived tier tag to the subscriber.
    const tagResponse = await fetch(`${KIT_API_BASE}/subscribers/${subscriberId}/tags`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: kitTag }),
    });

    if (tagResponse.ok) {
      console.log(`ESP tag '${kitTag}' applied to subscriber ${subscriberId}`);
    } else {
      const tagError = await tagResponse.json().catch(() => ({}));
      console.error('ESP tag application failed:', tagResponse.status, tagError);
    }
  } catch (kitErr) {
    console.error('Failed ESP integration in quiz-submit', kitErr);
    // Non-fatal: continue with email flow.
  }
}

/**
 * Send the submitter result email and the internal admin notification. Non-fatal on failure.
 * @param {QuizSubmission} data
 * @param {string} tierName
 * @param {string} kitTag
 * @returns {Promise<void>}
 */
async function sendEmails(data, tierName, kitTag) {
  if (!resend) {
    console.log('RESEND_API_KEY not configured — skipping email');
    return;
  }

  try {
    const firstName = data.name.split(' ')[0] || data.name;

    // Submitter confirmation / result email.
    await resend.emails.send({
      from: FROM_EMAIL,
      to: data.email,
      subject: `Your ${tierName} result - ${BRAND_NAME}`,
      html: renderResultEmail(firstName, tierName),
    });

    // Internal admin notification.
    await resend.emails.send({
      from: FROM_EMAIL,
      to: TO_EMAIL,
      subject: `New Quiz Submission: ${data.name} — ${data.niche} — ${tierName}`,
      html: renderAdminEmail({
        name: data.name,
        email: data.email,
        quizSlug: data.quiz_slug || data.niche,
        tier: data.tier,
        tierName,
        niche: data.niche,
        kitTag,
        consentHealthData: Boolean(data.consent_health_data),
        consentTimestamp: data.consent_timestamp || '',
      }),
    });
  } catch (emailErr) {
    console.error('Failed to send email via provider', emailErr);
    // Non-fatal: submission succeeded even if emails fail.
  }
}

/**
 * Netlify-style serverless HTTP handler for quiz/assessment submissions.
 *
 * Pipeline order (see file header): validate → store → ESP sync → email. Storage runs first so a
 * submission is never lost to a downstream provider outage; each side-effect is independently
 * non-fatal and a 200 is returned once the request validates.
 *
 * @param {HttpEvent} event
 * @returns {Promise<HttpResult>}
 */
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  try {
    /** @type {QuizSubmission} */
    const quizData = JSON.parse(event.body || '{}');
    const { name, email, niche, tier } = quizData;

    // Boundary validation — required fields.
    if (!name || !email || !niche || !tier) {
      return jsonResponse(400, { error: 'Name, email, niche, and tier are required' });
    }

    // Reject obviously malformed emails at the boundary — the value is used directly as the
    // recipient address and persisted, so validate before any side-effect runs.
    if (!isValidEmail(email)) {
      return jsonResponse(400, { error: 'A valid email address is required' });
    }

    // Construct the ESP tag server-side (never trust client for tag name).
    const kitTag = buildTierTag(niche, tier);
    const tierName = TIER_NAMES[tier] || `Tier ${tier}`;

    // 1) Consent-tracked storage first (source of truth for the lead).
    await storeSubmission(quizData, kitTag);

    // 2) ESP tagging.
    await syncToEsp(quizData, kitTag);

    // 3) Personalized + admin emails.
    await sendEmails(quizData, tierName, kitTag);

    return jsonResponse(200, { success: true, message: 'Quiz submitted successfully' });
  } catch (err) {
    console.error('Unhandled error in quiz-submit handler', err);
    return jsonResponse(500, { error: 'Internal server error' });
  }
};
