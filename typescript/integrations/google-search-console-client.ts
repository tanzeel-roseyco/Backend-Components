/**
 * Google Search Console (GSC) API Client
 * ---------------------------------------
 * Type-safe client for the Search Console `searchanalytics` API using
 * Google service-account authentication (read-only). Exposes search analytics
 * rows across configurable dimensions, date ranges, optional country filtering,
 * and row limits.
 *
 * Adapted and generalized from a production codebase.
 *
 * Required environment variables:
 *   GOOGLE_SERVICE_ACCOUNT_KEY  — Service-account credentials. Either a JSON
 *                                 string of the key file contents, OR a path to
 *                                 the key file on disk. The client auto-detects:
 *                                 if the value parses as JSON it is used inline,
 *                                 otherwise it is treated as a keyFile path.
 *   GSC_SITE_URL                — Verified Search Console property URL,
 *                                 e.g. "https://www.example.com" or
 *                                 "sc-domain:example.com".
 *
 * Key dependencies:
 *   googleapis — official Google API client (provides auth + webmasters v3).
 *
 * Note: Role — read-only GSC data-access adapter at the integration
 * boundary. Security/ordering constraints:
 *   - Credentials are ONLY sourced from env vars or explicit constructor args;
 *     never hardcode a key here (public repo). Fail loud if neither is set.
 *   - Auth scope is pinned to `webmasters.readonly` — do not widen it; this
 *     client must never mutate Search Console state.
 *   - getClient() must resolve auth BEFORE any query call; each public method
 *     awaits it first, so callers never touch an unauthenticated client.
 */

import { google } from 'googleapis';

/**
 * A raw Search Console analytics row as returned by the API, with `keys`
 * ordered to match the requested `dimensions` array.
 */
export interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/**
 * A flattened keyword/query record covering the
 * query + page + country + device dimensions.
 */
export interface GscKeyword {
  query: string;
  page: string;
  country: string;
  device: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/**
 * Options controlling a search-analytics export.
 */
export interface GscExportOptions {
  /** Inclusive start date, ISO `YYYY-MM-DD`. */
  startDate: string;
  /** Inclusive end date, ISO `YYYY-MM-DD`. */
  endDate: string;
  /** Optional ISO-3166-1 alpha-3 country code (e.g. "usa", "gbr") to filter by. */
  country?: string;
  /**
   * Max rows to return. Defaults to 25,000. Values are clamped to GSC's valid
   * range [1, 25,000]; out-of-range inputs are coerced, not rejected.
   */
  rowLimit?: number;
}

/**
 * Type-safe Google Search Console client.
 *
 * @example
 * const client = new GscClient(); // reads GSC_SITE_URL + GOOGLE_SERVICE_ACCOUNT_KEY
 * const rows = await client.exportKeywords({
 *   startDate: '2024-01-01',
 *   endDate: '2024-01-31',
 *   country: 'usa',
 * });
 */
export class GscClient {
  private readonly siteUrl: string;
  private readonly serviceAccountKey: string;

  /**
   * @param siteUrl            Verified GSC property URL. Falls back to
   *                           `process.env.GSC_SITE_URL`.
   * @param serviceAccountKey  Service-account key as a JSON string or a file
   *                           path. Falls back to
   *                           `process.env.GOOGLE_SERVICE_ACCOUNT_KEY`.
   */
  constructor(siteUrl?: string, serviceAccountKey?: string) {
    this.siteUrl = siteUrl ?? process.env.GSC_SITE_URL ?? '';
    this.serviceAccountKey =
      serviceAccountKey ?? process.env.GOOGLE_SERVICE_ACCOUNT_KEY ?? '';
  }

  /**
   * True when `value` is a strict, calendar-valid ISO date (`YYYY-MM-DD`).
   * Rejects malformed strings and impossible dates like `2024-02-30`.
   */
  private static isIsoDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    // Round-trip through the parsed date to reject overflow (e.g. Feb 30 → Mar 1).
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  /**
   * Builds an authenticated Search Console (webmasters v3) client.
   *
   * Note: The service-account key may arrive as inline JSON or as a file
   * path. We try JSON.parse first; on failure we treat the value as a keyFile
   * path. This is the one spot allowed to branch on credential shape.
   *
   * @returns An authenticated webmasters v3 client.
   */
  private async getClient() {
    // Fail loud (see file-level NOTE) if required config is missing.
    // Validated lazily here rather than in the constructor so that importing
    // this module — and the `gscClient` singleton below — never throws just
    // because env vars are unset; failure surfaces only on actual use.
    if (!this.serviceAccountKey) {
      throw new Error(
        'GscClient: missing service-account key. Set GOOGLE_SERVICE_ACCOUNT_KEY ' +
          '(inline JSON or key-file path) or pass it to the constructor.',
      );
    }
    if (!this.siteUrl) {
      throw new Error(
        'GscClient: missing site URL. Set GSC_SITE_URL (e.g. ' +
          '"https://www.example.com" or "sc-domain:example.com") or pass it to the constructor.',
      );
    }

    let credentials: Record<string, unknown> | undefined;
    try {
      credentials = JSON.parse(this.serviceAccountKey) as Record<string, unknown>;
    } catch {
      credentials = undefined;
    }

    const auth = new google.auth.GoogleAuth({
      ...(credentials ? { credentials } : { keyFile: this.serviceAccountKey }),
      // Read-only scope — do not widen (see file-level NOTE).
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
    });

    const authClient = await auth.getClient();
    return google.webmasters({ version: 'v3', auth: authClient });
  }

  /**
   * Queries search analytics across query/page/country/device dimensions and
   * returns flattened {@link GscKeyword} records.
   *
   * @param options  Date range, optional country filter, and row limit.
   * @returns A list of keyword records; empty array when GSC returns no rows.
   */
  async exportKeywords(options: GscExportOptions): Promise<GscKeyword[]> {
    // Sanitise dates at the boundary — GSC expects strict ISO `YYYY-MM-DD`.
    // Catch obviously malformed input here rather than surfacing an opaque
    // 400 from the API further down the call chain.
    if (!GscClient.isIsoDate(options.startDate) || !GscClient.isIsoDate(options.endDate)) {
      throw new Error(
        `GscClient: startDate/endDate must be ISO YYYY-MM-DD; got "${options.startDate}" / "${options.endDate}".`,
      );
    }

    // Clamp rowLimit to the API's valid range. GSC hard-caps at 25,000 per
    // request and rejects non-positive limits, so we never forward an
    // out-of-range value that would trigger a 400.
    const rowLimit = Math.min(Math.max(options.rowLimit ?? 25000, 1), 25000);

    const client = await this.getClient();

    const response = await client.searchanalytics.query({
      siteUrl: this.siteUrl,
      requestBody: {
        startDate: options.startDate,
        endDate: options.endDate,
        dimensions: ['query', 'page', 'country', 'device'],
        rowLimit,
        ...(options.country && {
          dimensionFilterGroups: [
            {
              filters: [
                {
                  dimension: 'country',
                  operator: 'equals',
                  expression: options.country,
                },
              ],
            },
          ],
        }),
      },
    });

    if (!response.data.rows) return [];

    // Row `keys` are ordered to match the `dimensions` array above.
    return response.data.rows.map((row) => ({
      query: row.keys?.[0] ?? '',
      page: row.keys?.[1] ?? '',
      country: row.keys?.[2] ?? '',
      device: row.keys?.[3] ?? '',
      clicks: row.clicks ?? 0,
      impressions: row.impressions ?? 0,
      ctr: row.ctr ?? 0,
      position: row.position ?? 0,
    }));
  }
}

/**
 * Default singleton configured entirely from environment variables.
 * Prefer constructing your own {@link GscClient} when you need explicit config.
 */
export const gscClient = new GscClient();
