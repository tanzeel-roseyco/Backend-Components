/**
 * SEO Ranking Tracker (Scheduled)
 * ================================
 * Scheduled serverless function that pulls top search queries from the
 * Google Search Console (GSC) Search Analytics API and persists them into a
 * Supabase table (`ranking_history`) using batched upserts.
 *
 * Designed to run on a cron schedule (default 06:00 UTC daily) on Netlify
 * Scheduled Functions, but the core `runRankingSync` routine is
 * runtime-agnostic and can be driven by any scheduler (cron, Lambda, etc.).
 *
 * Reusable pattern highlighted here: chunked "batch upsert" — large row sets
 * are sliced into fixed-size batches (default 500) and upserted with a
 * composite conflict key, so a single oversized payload never breaks the
 * request and partial failures are isolated per batch.
 *
 * Required environment variables:
 *   GOOGLE_SERVICE_ACCOUNT_KEY - JSON string of a Google service-account key
 *                                with GSC read access to GSC_SITE_URL.
 *   GSC_SITE_URL               - Verified property URL, e.g. https://example.com
 *   SUPABASE_URL               - Supabase project URL.
 *   SUPABASE_SERVICE_ROLE_KEY  - Supabase service-role key (server-side only).
 *
 * Optional environment variables:
 *   GSC_COUNTRY_FILTER - ISO-3166 alpha-3 country code to filter on (default 'gbr').
 *   RANKING_BATCH_SIZE - Upsert batch size (default 500).
 *
 * Key dependencies:
 *   @supabase/supabase-js - Supabase client for upserts.
 *   googleapis            - Google Search Console (webmasters v3) client.
 *   @netlify/functions    - `schedule()` wrapper (only for the Netlify entrypoint).
 *
 * AIDEV-NOTE: Adapted and generalized from a production codebase.
 * Role: nightly SEO metrics ingestion. Security/ordering constraints:
 *   - SUPABASE_SERVICE_ROLE_KEY grants full DB access — server-side ONLY, never
 *     ship to a client bundle.
 *   - GSC data lags ~2-3 days, so the query window ends 3 days back on purpose;
 *     do not "fix" the endDate to today or rows will come back empty.
 *   - Upsert conflict key must match the table's unique constraint exactly, or
 *     rows duplicate instead of updating.
 */

'use strict';

// AIDEV-NOTE: Deps are the true external boundaries; require lazily is not
// needed here since both are used on every invocation.
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');

/**
 * @typedef {Object} RankingSyncOptions
 * @property {number} [batchSize=500]     Upsert batch size.
 * @property {string} [countryFilter]     ISO-3166 alpha-3 country code (e.g. 'gbr').
 * @property {number} [lagDays=3]         Days to subtract from "now" for the window end (GSC data lag).
 * @property {number} [windowDays=28]     Length of the lookback window in days (end - windowDays = start).
 * @property {number} [rowLimit=25000]    Max rows requested from GSC per query.
 * @property {Console} [logger=console]   Injectable logger (must expose log/error).
 */

/**
 * @typedef {Object} RankingRecord
 * @property {string} page_url
 * @property {string} target_keyword
 * @property {number|null} position
 * @property {number} clicks
 * @property {number} impressions
 * @property {number} ctr
 * @property {string} country
 * @property {string} device
 * @property {string} date
 * @property {string} source
 */

/**
 * @typedef {Object} RankingSyncResult
 * @property {boolean} success
 * @property {number} rows      Rows returned by GSC.
 * @property {number} stored    Rows successfully upserted.
 * @property {string} duration  Human-readable duration, e.g. "1.23s".
 * @property {string} [message] Present when there was nothing to store.
 */

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_COUNTRY_FILTER = 'gbr';
const DEFAULT_LAG_DAYS = 3;
const DEFAULT_WINDOW_DAYS = 28;
const DEFAULT_ROW_LIMIT = 25000;
const REQUIRED_ENV = ['GOOGLE_SERVICE_ACCOUNT_KEY', 'GSC_SITE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Format a Date as an ISO date string (YYYY-MM-DD), UTC.
 * @param {Date} d
 * @returns {string}
 */
function toIsoDate(d) {
  return d.toISOString().split('T')[0];
}

/**
 * Upsert a large array of records into a Supabase table in fixed-size batches.
 *
 * This is the reusable batch-insert pattern: slicing keeps each request within
 * payload limits and isolates failures to a single batch (a failed batch is
 * logged and skipped rather than aborting the whole run).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} table                 Target table name.
 * @param {ReadonlyArray<Record<string, unknown>>} records Rows to upsert.
 * @param {Object} opts
 * @param {string} opts.onConflict        Comma-separated columns forming the conflict key.
 * @param {number} [opts.batchSize=500]   Rows per batch.
 * @param {Console} [opts.logger=console]
 * @returns {Promise<number>} Count of successfully upserted rows.
 */
async function batchUpsert(supabase, table, records, opts = {}) {
  const { onConflict, batchSize = DEFAULT_BATCH_SIZE, logger = console } = opts;

  // Validate at the boundary: this is exported, so callers may pass anything.
  if (!onConflict) {
    throw new Error('batchUpsert requires opts.onConflict');
  }
  if (!Array.isArray(records) || records.length === 0) {
    return 0; // Nothing to store — empty/absent input is a no-op, not an error.
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`batchUpsert batchSize must be a positive integer, got: ${batchSize}`);
  }

  let stored = 0;

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const { error } = await supabase.from(table).upsert(batch, { onConflict });

    if (error) {
      // AIDEV-NOTE: Isolate per-batch failures — log and continue so one bad
      // batch does not discard the rows that did succeed.
      logger.error(`Batch ${Math.floor(i / batchSize) + 1} error:`, error.message);
    } else {
      stored += batch.length;
    }
  }

  return stored;
}

/**
 * Core routine: pull GSC search-analytics rows and upsert them into Supabase.
 * Runtime-agnostic — invoke from any scheduler.
 *
 * @param {RankingSyncOptions} [options]
 * @returns {Promise<RankingSyncResult>}
 * @throws {Error} If required env vars are missing or the GSC/Supabase calls fail.
 */
async function runRankingSync(options = {}) {
  const {
    batchSize = Number(process.env.RANKING_BATCH_SIZE) || DEFAULT_BATCH_SIZE,
    countryFilter = process.env.GSC_COUNTRY_FILTER || DEFAULT_COUNTRY_FILTER,
    lagDays = DEFAULT_LAG_DAYS,
    windowDays = DEFAULT_WINDOW_DAYS,
    rowLimit = DEFAULT_ROW_LIMIT,
    logger = console,
  } = options;

  const start = Date.now();
  logger.log('=== Starting rank tracking ===', new Date().toISOString());

  // Validate at the boundary: fail loud if configuration is incomplete.
  const missing = REQUIRED_ENV.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(`Missing env vars: ${missing.join(', ')}`);
  }

  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
  const authClient = await auth.getClient();
  const gsc = google.webmasters({ version: 'v3', auth: authClient });

  // AIDEV-NOTE: GSC data lags ~2-3 days; window ends `lagDays` back on purpose.
  const endDate = toIsoDate(new Date(Date.now() - lagDays * MS_PER_DAY));
  const startDate = toIsoDate(new Date(Date.now() - (windowDays + lagDays) * MS_PER_DAY));
  const today = toIsoDate(new Date());

  logger.log(`Fetching GSC data: ${startDate} -> ${endDate}`);

  // AIDEV-NOTE: Single request, no pagination. GSC caps rowLimit at 25000; if a
  // property exceeds that in the window, extra rows are silently dropped. Add a
  // startRow paging loop here if that ceiling is ever hit.
  const response = await gsc.searchanalytics.query({
    siteUrl: process.env.GSC_SITE_URL,
    requestBody: {
      startDate,
      endDate,
      dimensions: ['query', 'page', 'country', 'device'],
      rowLimit,
      dimensionFilterGroups: [
        { filters: [{ dimension: 'country', operator: 'equals', expression: countryFilter }] },
      ],
    },
  });

  const rows = response.data.rows || [];
  logger.log(`Fetched ${rows.length} rows from GSC`);

  if (rows.length === 0) {
    const duration = ((Date.now() - start) / 1000).toFixed(2);
    return { success: true, message: 'No GSC data', rows: 0, stored: 0, duration: `${duration}s` };
  }

  // Map GSC dimension tuples -> flat ranking records.
  // keys order matches `dimensions` above: [query, page, country, device].
  /** @type {RankingRecord[]} */
  const records = rows.map((row) => ({
    page_url: row.keys[1],
    target_keyword: row.keys[0],
    position: row.position || null,
    clicks: row.clicks || 0,
    impressions: row.impressions || 0,
    ctr: row.ctr || 0,
    country: row.keys[2] || countryFilter,
    device: row.keys[3] || 'all',
    date: today,
    source: 'gsc',
  }));

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // AIDEV-NOTE: onConflict columns MUST match the table's unique constraint,
  // or upserts insert duplicates instead of updating.
  const stored = await batchUpsert(supabase, 'ranking_history', records, {
    onConflict: 'page_url,target_keyword,date,device,country',
    batchSize,
    logger,
  });

  const duration = ((Date.now() - start) / 1000).toFixed(2);
  logger.log(`Stored ${stored} records in ${duration}s`);

  return { success: true, rows: rows.length, stored, duration: `${duration}s` };
}

/**
 * Netlify-shaped handler. Wraps `runRankingSync` and translates the result
 * (or thrown error) into an HTTP-style response object.
 *
 * @param {unknown} [_event] Netlify event (unused).
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
async function handler(_event) {
  try {
    const result = await runRankingSync();
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Track rankings failed:', message);
    // AIDEV-NOTE: This runs on a scheduler (no HTTP caller), so every failure —
    // missing env, GSC auth, or Supabase — is a server-side 500. If ever fronted
    // by a real client, split config errors (missing env / bad key) into a 4xx.
    return { statusCode: 500, body: JSON.stringify({ success: false, error: message }) };
  }
}

// --- Netlify Scheduled Function entrypoint ---------------------------------
// AIDEV-NOTE: `schedule()` is only needed for the Netlify runtime. Guarded so
// importing this module elsewhere (tests, other schedulers) doesn't require
// @netlify/functions to be installed.
let scheduledHandler = handler;
try {
  // eslint-disable-next-line global-require
  const { schedule } = require('@netlify/functions');
  scheduledHandler = schedule('0 6 * * *', handler); // daily at 06:00 UTC
} catch (_e) {
  // @netlify/functions not available — export the bare handler instead.
}

exports.handler = scheduledHandler;
exports.runRankingSync = runRankingSync;
exports.batchUpsert = batchUpsert;
