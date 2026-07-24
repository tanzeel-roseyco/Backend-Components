/**
 * Blog Audit & Publishing System
 * ================================
 * Serverless HTTP handlers for auditing and publishing blog posts held in a
 * Postgres-backed store (Supabase). Combines two operations into one module:
 *
 *   - list():   GET  — return all draft posts with their audit metadata.
 *   - update(): POST — either (A) update a single whitelisted field on one
 *                       draft post, or (B) bulk-publish a set of posts by id.
 *
 * Origin: Adapted and generalized from a production codebase
 * (originally two separate Netlify Functions, merged here into one module).
 *
 * Required environment variables:
 *   - SUPABASE_URL                Base URL of the Supabase project.
 *   - SUPABASE_SERVICE_ROLE_KEY   Service-role key (server-side ONLY — grants
 *                                 full read/write; never expose to a client).
 *
 * Key dependencies:
 *   - @supabase/supabase-js  (createClient)
 *
 * Note: Security-critical. Two constraints must never be relaxed:
 *   1. Single-field updates go through ALLOWED_FIELDS whitelisting so a caller
 *      can never write arbitrary columns (e.g. `status`, `id`) via `field`.
 *      This prevents column-injection / privilege escalation through the API.
 *   2. Single-field updates are scoped `.eq('status', 'draft')` so published
 *      posts stay immutable through this endpoint.
 * The service-role key bypasses row-level security, so this module IS the
 * authorization boundary — do not add write paths that skip the whitelist.
 *
 * Note: Handlers are pure request->response; the only shared state is the
 * lazily-built Supabase client. `getSupabaseClient()` returns null when env is
 * unconfigured so callers fail loud with a 500 rather than throwing on import.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

/**
 * @typedef {Object} SupabaseClient
 * Minimal structural interface for the subset of the Supabase JS client used
 * here. Declared locally so this module is understandable without pulling in
 * the full @supabase/supabase-js type surface.
 * @property {(table: string) => QueryBuilder} from
 */

/**
 * @typedef {Object} QueryBuilder
 * @property {(cols: string) => QueryBuilder} select
 * @property {(payload: Record<string, unknown>) => QueryBuilder} update
 * @property {(col: string, val: unknown) => QueryBuilder} eq
 * @property {(col: string, vals: unknown[]) => QueryBuilder} in
 * @property {(col: string, opts: { ascending: boolean }) => QueryBuilder} order
 */

/**
 * @typedef {Object} LambdaEvent
 * Netlify/AWS-Lambda style HTTP event.
 * @property {string} httpMethod  e.g. "GET", "POST".
 * @property {string} [body]      Raw request body (JSON string) for POST.
 */

/**
 * @typedef {Object} LambdaResponse
 * @property {number} statusCode
 * @property {Record<string, string>} [headers]
 * @property {string} body  Serialized JSON payload.
 */

/**
 * Columns a single-field update is permitted to write. Anything outside this
 * set is rejected with 400. This is the core injection guard — keep it tight.
 * @type {readonly string[]}
 */
const ALLOWED_FIELDS = Object.freeze(['niche', 'audit_status', 'audit_notes']);

/** Columns returned by the list endpoint. Explicit to avoid over-fetching. */
const LIST_COLUMNS =
  'id, title, slug, niche, audit_status, audit_notes, status, created_at, updated_at';

const JSON_HEADERS = Object.freeze({ 'Content-Type': 'application/json' });

/**
 * Build a Supabase client from the environment, or null if unconfigured.
 *
 * Note: autoRefreshToken/persistSession disabled — this is a stateless
 * server context with no session to persist; leaving them on leaks timers.
 *
 * @returns {SupabaseClient | null} Client, or null when env vars are missing.
 */
const getSupabaseClient = () => {
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!supabaseUrl || !supabaseServiceKey) {
    return null;
  }
  return /** @type {SupabaseClient} */ (
    createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  );
};

/**
 * Small helper for JSON responses to keep handlers terse and consistent.
 * @param {number} statusCode
 * @param {unknown} payload
 * @returns {LambdaResponse}
 */
const jsonResponse = (statusCode, payload) => ({
  statusCode,
  headers: JSON_HEADERS,
  body: JSON.stringify(payload),
});

/**
 * List all draft blog posts with their audit metadata, ordered by title.
 *
 * @param {LambdaEvent} event  HTTP event; must be a GET request.
 * @returns {Promise<LambdaResponse>} 200 with `{ posts }`, or an error status.
 */
const list = async (event) => {
  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      return jsonResponse(500, { error: 'Database not configured' });
    }
    const { data, error } = await supabase
      .from('blog_posts')
      .select(LIST_COLUMNS)
      .eq('status', 'draft')
      .order('title', { ascending: true });
    if (error) {
      return jsonResponse(500, { error: error.message });
    }
    return jsonResponse(200, { posts: data });
  } catch (err) {
    // Log server-side, return a generic message to avoid leaking internals.
    console.error('blog-audit list error', err);
    return jsonResponse(500, { error: 'Internal error' });
  }
};

/**
 * Update audit state, or bulk-publish posts.
 *
 * Two mutually exclusive paths, dispatched from the request body:
 *   - Bulk publish: `{ action: 'publish', ids: string[] }` — sets
 *     `status = 'published'` on every listed id.
 *   - Single field update: `{ id, field, value }` — writes one whitelisted
 *     field on a single DRAFT post (published posts are not matched).
 *
 * @param {LambdaEvent} event  HTTP event; must be a POST request.
 * @returns {Promise<LambdaResponse>} 200 on success, 4xx/5xx on failure.
 */
const update = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      return jsonResponse(500, { error: 'Database not configured' });
    }

    /** @type {{ action?: string, ids?: unknown, id?: unknown, field?: unknown, value?: unknown }} */
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      // Malformed JSON is a client error, not a server fault.
      return jsonResponse(400, { error: 'Invalid JSON body' });
    }

    // Path B: Bulk publish.
    if (body.action === 'publish' && Array.isArray(body.ids) && body.ids.length > 0) {
      const { error } = await supabase
        .from('blog_posts')
        .update({ status: 'published' })
        .in('id', body.ids);
      if (error) {
        return jsonResponse(500, { error: error.message });
      }
      return jsonResponse(200, { success: true, published: body.ids.length });
    }

    // Path A: Single field update.
    const { id, field, value } = body;
    if (!id || !field || typeof field !== 'string') {
      return jsonResponse(400, { error: 'id and field are required' });
    }
    // Note: Whitelist check is the injection guard — reject any column
    // not explicitly allowed before it ever reaches the query builder.
    if (!ALLOWED_FIELDS.includes(field)) {
      return jsonResponse(400, {
        error: `Field '${field}' is not allowed. Allowed: ${ALLOWED_FIELDS.join(', ')}`,
      });
    }
    const { error } = await supabase
      .from('blog_posts')
      .update({ [field]: value })
      .eq('id', id)
      // Scope to drafts so published content cannot be mutated via this path.
      .eq('status', 'draft');
    if (error) {
      return jsonResponse(500, { error: error.message });
    }
    return jsonResponse(200, { success: true });
  } catch (err) {
    console.error('blog-audit update error', err);
    return jsonResponse(500, { error: 'Internal error' });
  }
};

module.exports = {
  ALLOWED_FIELDS,
  getSupabaseClient,
  list,
  update,
};
