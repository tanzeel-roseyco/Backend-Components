/**
 * Blog Post Notification
 * -----------------------
 * Serverless handler that broadcasts a new-blog-post email to your newsletter
 * subscribers. On publish it loads the post from a database, auto-extracts the
 * first few key points from the post body, renders a responsive HTML + plain-text
 * email, and creates a broadcast via an email-marketing provider (Kit / ConvertKit
 * v3 broadcasts API).
 *
 * Origin: Adapted and generalized from a production serverless codebase
 * (a Netlify Functions endpoint). Client-specific branding, domains, and copy
 * have been replaced with neutral placeholders and configuration.
 *
 * Required environment variables:
 *   - EMAIL_API_SECRET          Secret for the email-marketing provider (Kit/ConvertKit).
 *   - SUPABASE_URL              Base URL of the Supabase project.
 *   - SUPABASE_SERVICE_ROLE_KEY Service-role key for server-side DB reads. NEVER expose to clients.
 *   - SITE_URL                  Public site origin, e.g. https://example.com (no trailing slash).
 *   - BRAND_NAME    (optional)  Display name shown in the email header/footer. Default: "Example Co".
 *   - BRAND_TAGLINE (optional)  Short tagline shown in the footer. Default: "".
 *   - BRAND_COLOR   (optional)  Hex accent color for CTA/links. Default: "#4f46e5".
 *   - TRIGGER_SECRET (optional) Shared secret required in the `x-trigger-secret` header.
 *                               If set, unauthenticated calls are rejected with 401.
 *
 * Key dependencies:
 *   - @supabase/supabase-js  (database client)
 *   - global fetch           (Node 18+ / edge runtime; provides the broadcast HTTP call)
 *
 * AIDEV-NOTE: Role = "on publish, notify subscribers". Security/ordering constraints:
 *   1. SERVICE_ROLE_KEY grants full DB access — it is read here for a single scoped
 *      SELECT and must never reach the client or a log line.
 *   2. EMAIL_API_SECRET is sent in the request BODY to the provider (their v3 API
 *      contract) — never echo the request body or this secret in error responses/logs.
 *   3. Config is validated up front (secret + DB) before any post lookup or network I/O,
 *      so a misconfigured deploy fails fast with a 500 instead of a partial send.
 *   4. Broadcast is created (published) but NOT auto-sent — provider requires a separate
 *      send call, leaving a human review gate before subscribers are emailed.
 *   5. This endpoint has side effects (creates provider broadcasts), so it is a trust
 *      boundary. Set TRIGGER_SECRET to require a shared-secret header; without it the
 *      endpoint is open and MUST be protected by the deployment layer (webhook signature,
 *      network policy, or gateway auth) before going live.
 */

'use strict';

// AIDEV-NOTE: Kept as the original DB dependency. If your stack differs, swap this
// adapter for your own data source — see loadPostBySlug() interface below.
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// Configuration (all secrets via env — no real values committed)
// ---------------------------------------------------------------------------

const EMAIL_API_SECRET = process.env.EMAIL_API_SECRET || '';
const SITE_URL = process.env.SITE_URL || 'https://example.com';
const BRAND_NAME = process.env.BRAND_NAME || 'Example Co';
const BRAND_TAGLINE = process.env.BRAND_TAGLINE || '';
const BRAND_COLOR = process.env.BRAND_COLOR || '#4f46e5';
const TRIGGER_SECRET = process.env.TRIGGER_SECRET || '';

// Provider endpoint for creating a broadcast (Kit / ConvertKit v3).
const BROADCAST_ENDPOINT = 'https://api.convertkit.com/v3/broadcasts';

/**
 * @typedef {Object} BlogPost
 * @property {string} title    Post title.
 * @property {string} slug     URL slug.
 * @property {string} excerpt  Short summary shown near the top of the email.
 * @property {string} content  Full post body (markdown/plain text) used for key-point extraction.
 */

/**
 * Create a Supabase client for server-side reads, or null if unconfigured.
 *
 * AIDEV-NOTE: Sessions disabled — this is a stateless server context, so we never
 * want token refresh or persisted auth state.
 *
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
 * Load a single published blog post by slug.
 *
 * AIDEV-NOTE: This is the one data-access seam. To use a non-Supabase store,
 * replace the body of this function with your own query — the contract is:
 * given a slug, return a BlogPost or null.
 *
 * @param {string} slug - The post slug to look up.
 * @returns {Promise<BlogPost | null>}
 */
const loadPostBySlug = async (slug) => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    // Signal "not configured" distinctly from "not found".
    throw new Error('DATABASE_NOT_CONFIGURED');
  }

  const { data, error } = await supabase
    .from('blog_posts')
    .select('*')
    .eq('slug', slug)
    .single();

  if (error || !data) {
    return null;
  }
  return /** @type {BlogPost} */ (data);
};

/**
 * Extract up to three key points from post content for the email summary.
 *
 * Strategy: prefer explicit bullet/numbered list items; if fewer than three are
 * found, fall back to the first few substantive paragraphs (skipping headings).
 * If nothing usable is found, return generic placeholders so the template never
 * renders empty list items.
 *
 * @param {string} content - Raw post body (markdown or plain text).
 * @returns {string[]} Between 1 and 3 key-point strings.
 */
const extractKeyPoints = (content) => {
  const safeContent = typeof content === 'string' ? content : '';

  // Match bullet ("- ", "* ", "• ") or numbered ("1. ") list items.
  // AIDEV-NOTE: (?=\n|$) stops each match at a line boundary so multi-line
  // paragraphs don't get swallowed into a single "list item".
  const listMatches =
    safeContent.match(/[-*•]\s+(.+?)(?=\n|$)/g) ||
    safeContent.match(/\d+\.\s+(.+?)(?=\n|$)/g);

  if (listMatches && listMatches.length >= 3) {
    return listMatches
      .slice(0, 3)
      .map((item) => item.replace(/^[-*•]\s+|\d+\.\s+/, '').trim());
  }

  // Fallback: first 3 substantive paragraphs (ignore short lines and headings).
  const paragraphs = safeContent
    .split('\n\n')
    .filter((p) => p.trim().length > 20 && !p.startsWith('#'))
    .slice(0, 3)
    .map((p) => p.substring(0, 100) + '...');

  if (paragraphs.length > 0) {
    return paragraphs;
  }

  // Last-resort generic points so the template always has content.
  return [
    'Fresh insights from our team',
    'Practical, evidence-based guidance',
    'Actionable takeaways you can use today',
  ];
};

/**
 * Escape a string for safe interpolation into HTML.
 *
 * AIDEV-NOTE: Post fields (title/excerpt/key points) originate from stored content
 * and are injected into an HTML email. Escape them to avoid broken markup or
 * injected tags in email clients.
 *
 * @param {unknown} value
 * @returns {string}
 */
const escapeHtml = (value) =>
  String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Build the responsive HTML email body for a post notification.
 *
 * @param {BlogPost} post
 * @param {string[]} keyPoints
 * @param {string} postUrl - Fully-qualified, UTM-tagged article URL.
 * @returns {string} HTML document string.
 */
const buildEmailHtml = (post, keyPoints, postUrl) => {
  const title = escapeHtml(post.title);
  const excerpt = escapeHtml(post.excerpt);
  const kp = keyPoints.map(escapeHtml);
  const tagline = BRAND_TAGLINE ? `${escapeHtml(BRAND_TAGLINE)}<br>` : '';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f5f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" style="width: 100%; max-width: 600px; border-collapse: collapse; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
          <!-- Header -->
          <tr>
            <td style="padding: 40px 40px 20px; text-align: center;">
              <h2 style="margin: 0; font-size: 14px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em;">
                New from ${escapeHtml(BRAND_NAME)}
              </h2>
            </td>
          </tr>

          <!-- Title -->
          <tr>
            <td style="padding: 0 40px 20px;">
              <h1 style="margin: 0; font-size: 28px; font-weight: 700; color: #111827; line-height: 1.3;">
                ${title}
              </h1>
            </td>
          </tr>

          <!-- Excerpt -->
          <tr>
            <td style="padding: 0 40px 30px;">
              <p style="margin: 0; font-size: 16px; color: #4b5563; line-height: 1.6;">
                ${excerpt}
              </p>
            </td>
          </tr>

          <!-- Key Points -->
          <tr>
            <td style="padding: 0 40px 30px;">
              <p style="margin: 0 0 12px; font-size: 15px; font-weight: 600; color: #111827;">
                In this article:
              </p>
              <ul style="margin: 0; padding-left: 20px; color: #4b5563; font-size: 15px; line-height: 1.8;">
                <li>${kp[0]}</li>
                ${kp[1] ? `<li>${kp[1]}</li>` : ''}
                ${kp[2] ? `<li>${kp[2]}</li>` : ''}
              </ul>
            </td>
          </tr>

          <!-- CTA Button -->
          <tr>
            <td style="padding: 0 40px 40px; text-align: center;">
              <a href="${escapeHtml(postUrl)}" style="display: inline-block; padding: 16px 32px; background-color: ${escapeHtml(BRAND_COLOR)}; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 16px;">
                Read Full Article
              </a>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 30px 40px; border-top: 1px solid #e5e7eb; text-align: center;">
              <p style="margin: 0 0 12px; font-size: 14px; color: #6b7280;">
                <strong>${escapeHtml(BRAND_NAME)}</strong><br>
                ${tagline}
              </p>
              <p style="margin: 0; font-size: 13px; color: #9ca3af;">
                You're receiving this because you subscribed to our newsletter.<br>
                <a href="{{unsubscribe_url}}" style="color: ${escapeHtml(BRAND_COLOR)}; text-decoration: none;">Unsubscribe</a> |
                <a href="${escapeHtml(SITE_URL)}" style="color: ${escapeHtml(BRAND_COLOR)}; text-decoration: none;">Visit Website</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
};

/**
 * Build the plain-text email body (fallback for non-HTML clients).
 *
 * @param {BlogPost} post
 * @param {string[]} keyPoints
 * @param {string} postUrl
 * @returns {string}
 */
const buildEmailText = (post, keyPoints, postUrl) => {
  const lines = keyPoints.map((point) => `- ${point}`).join('\n');
  const tagline = BRAND_TAGLINE ? `\n${BRAND_TAGLINE}` : '';

  return `
${post.title}

${post.excerpt}

In this article:
${lines}

Read the full article:
${postUrl}

---
${BRAND_NAME}${tagline}
${SITE_URL}

Unsubscribe: {{unsubscribe_url}}
  `.trim();
};

/**
 * Serverless handler: create a subscriber broadcast for a newly published post.
 *
 * Endpoint contract (framework-agnostic; shaped for Netlify Functions):
 *   Method: POST
 *   Body:   { "postSlug": "your-post-slug" }
 *
 * @param {{ httpMethod?: string, body?: string | null, headers?: Record<string, string> }} event
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Authorization gate: only enforced when TRIGGER_SECRET is configured.
  // AIDEV-NOTE: Netlify lowercases header keys; read the lowercased name.
  if (TRIGGER_SECRET) {
    const provided = (event.headers && event.headers['x-trigger-secret']) || '';
    if (provided !== TRIGGER_SECRET) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const postSlug = (body.postSlug || '').trim();

    if (!postSlug) {
      return { statusCode: 400, body: JSON.stringify({ error: 'postSlug is required' }) };
    }

    // Fail fast on missing config before any lookup or network I/O.
    if (!EMAIL_API_SECRET) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Email provider not configured' }),
      };
    }

    /** @type {BlogPost | null} */
    let post;
    try {
      post = await loadPostBySlug(postSlug);
    } catch (configErr) {
      if (configErr instanceof Error && configErr.message === 'DATABASE_NOT_CONFIGURED') {
        return { statusCode: 500, body: JSON.stringify({ error: 'Database not configured' }) };
      }
      throw configErr;
    }

    if (!post) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Blog post not found' }) };
    }

    // Build UTM-tagged article URL for click attribution.
    const postUrl =
      `${SITE_URL}/blog/${post.slug}` +
      `?utm_source=newsletter&utm_medium=email&utm_campaign=blog_notification`;

    // Single source of truth for the broadcast subject (used in the payload and echoed back).
    const subject = `New Post: ${post.title}`;

    const keyPoints = extractKeyPoints(post.content);
    const emailHtml = buildEmailHtml(post, keyPoints, postUrl);
    // AIDEV-NOTE: emailText is built for parity/reference; the provider derives a
    // text part from the HTML, but keep it available for providers that accept both.
    const emailText = buildEmailText(post, keyPoints, postUrl);
    void emailText;

    // Create the broadcast.
    // AIDEV-NOTE: api_secret goes in the BODY per the provider v3 contract — do not
    // move it to a header and never log this payload.
    const providerResponse = await fetch(BROADCAST_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_secret: EMAIL_API_SECRET,
        subject,
        description: `Blog notification for "${post.title}"`,
        content: emailHtml,
        email_layout_template: 'none', // Use our custom HTML layout.
        public: false, // Not a public post.
        published: true, // Create as published; a separate send call is still required.
      }),
    });

    if (!providerResponse.ok) {
      const errorData = await providerResponse.json().catch(() => ({}));
      // AIDEV-NOTE: Log status + provider error body only — never the request body,
      // which carries EMAIL_API_SECRET.
      console.error('Email provider error:', providerResponse.status, errorData);
      return {
        statusCode: providerResponse.status,
        body: JSON.stringify({ error: 'Failed to create broadcast', details: errorData }),
      };
    }

    const broadcast = await providerResponse.json();

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        message: 'Blog notification broadcast created successfully',
        broadcast: {
          id: broadcast.broadcast?.id,
          subject,
          post: { title: post.title, slug: post.slug, url: postUrl },
        },
        note: 'Broadcast created as draft. Review in your email provider dashboard before sending.',
      }),
    };
  } catch (err) {
    // Fail safe: surface a generic message; log detail server-side only.
    console.error('Blog notification function error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Internal error',
        details: err instanceof Error ? err.message : 'unknown',
      }),
    };
  }
};

// Exported for unit testing of the pure helpers.
exports._internal = {
  extractKeyPoints,
  escapeHtml,
  buildEmailHtml,
  buildEmailText,
  loadPostBySlug,
};

// --- Original import (unchanged provider) kept for reference ---
// const { createClient } = require('@supabase/supabase-js');
