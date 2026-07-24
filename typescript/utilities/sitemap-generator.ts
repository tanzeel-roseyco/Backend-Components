/**
 * Sitemap Generator
 * -----------------
 * Build-time generator for an XML sitemap (sitemap-0.9 schema) assembled from a
 * set of static routes plus dynamically-sourced entries (e.g. blog posts, docs,
 * product pages). Each entry emits <loc>, <lastmod>, <changefreq> and <priority>.
 *
 * Generalized from a production codebase. The original pulled its origin,
 * static routes and dynamic entries from hardcoded internal config modules;
 * here those are parameterized so the module is reusable and carries no
 * client/site-specific data.
 *
 * Required environment variables (only when using the convenience defaults):
 *   - SITE_ORIGIN  Absolute origin used to prefix every <loc>, e.g.
 *                  "https://example.com" (no trailing slash). Read only if an
 *                  explicit `origin` option is not supplied.
 *
 * Key dependencies:
 *   - Node.js built-ins only: `node:fs`, `node:path`. No third-party packages.
 *
 * Note: Role — pure build-time artifact generation; intended to run in a
 * build/prebuild step, NOT at request time. Ordering: `writeSitemap` must run
 * AFTER any dynamic data source (blog/CMS export) is available, otherwise the
 * dynamic section will be empty. Security: `origin` and every route `path` are
 * XML-escaped before interpolation to prevent malformed/injected sitemap XML
 * from untrusted dynamic entries — never bypass `escapeXml`.
 */

import fs from 'node:fs';
import path from 'node:path';

// Note: sitemaps.org caps a single sitemap file at 50,000 URLs (and 50MB
// uncompressed). Beyond this a sitemap index splitting into multiple files is
// required; we surface a warning rather than silently emit an invalid file.
const MAX_URLS_PER_SITEMAP = 50_000;

// Note: Original imported site/route/blog config from internal modules:
//   import { promotableBlogPosts } from '../src/data/blogPosts';
//   import { SITEMAP_ROUTES } from '../src/config/routes';
//   import { SITE_ORIGIN } from '../src/config/site';
// Those are project-specific and omitted here. Callers pass equivalent data via
// the options below; the expected shapes are declared as exported interfaces.

/** Valid values for the sitemap `<changefreq>` element (sitemaps.org spec). */
export type ChangeFreq =
  | 'always'
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'yearly'
  | 'never';

/**
 * A single sitemap route.
 * `priority` is kept as a string to preserve exact formatting (e.g. "0.7").
 * `lastmod` is optional; when omitted the generator falls back to "today".
 */
export interface Route {
  /** Path relative to the origin, must start with "/" (e.g. "/blog/hello"). */
  path: string;
  /** Priority "0.0".."1.0" as a string, per the sitemap spec. */
  priority: string;
  /** Update-frequency hint for crawlers. */
  changefreq: ChangeFreq;
  /** Optional last-modified date (ISO string or anything `Date` can parse). */
  lastmod?: string;
}

/**
 * Minimal shape of a dynamic content entry (e.g. a blog post) used to derive a
 * route. Mirrors the original internal blog-post model without its extra fields.
 */
export interface DynamicEntry {
  /** Stable identifier, used as a slug fallback. */
  id: string;
  /** URL-friendly slug; preferred over `id` when present. */
  slug?: string;
  /** Publish/update timestamp, mapped to <lastmod>. */
  publishedAt?: string;
}

/** Options controlling how dynamic entries are turned into routes. */
export interface DynamicRouteOptions {
  /** URL prefix for generated paths, e.g. "/blog". Default: "/blog". */
  basePath?: string;
  /** Priority for dynamic routes. Default: "0.7". */
  priority?: string;
  /** Change frequency for dynamic routes. Default: "monthly". */
  changefreq?: ChangeFreq;
}

/** Options for {@link generateSitemap} and {@link writeSitemap}. */
export interface SitemapOptions {
  /**
   * Absolute origin prefixed to every <loc> (no trailing slash).
   * Falls back to `process.env.SITE_ORIGIN` when omitted.
   */
  origin?: string;
  /** Static routes included verbatim. Default: []. */
  staticRoutes?: Route[];
  /** Dynamic content entries converted to routes. Default: []. */
  dynamicEntries?: DynamicEntry[];
  /** How to convert `dynamicEntries` into routes. */
  dynamicRouteOptions?: DynamicRouteOptions;
}

/**
 * Escape the five XML predefined entities so untrusted paths/origins cannot
 * break out of the surrounding XML context.
 * Note: Order matters — escape "&" first so we don't double-escape the
 * "&" introduced by the other replacements.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Format a date-ish value as an ISO date (YYYY-MM-DD), or `null` if invalid. */
function toIsoDate(value: string): string | null {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().split('T')[0];
}

/**
 * Resolve the origin from an explicit option or the SITE_ORIGIN env var.
 * Throws if neither is available — a sitemap without an origin is invalid.
 */
function resolveOrigin(origin?: string): string {
  const resolved = origin ?? process.env.SITE_ORIGIN;
  if (!resolved) {
    throw new Error(
      'Sitemap origin is required: pass `origin` or set the SITE_ORIGIN env var.',
    );
  }
  // Normalize away a single trailing slash so `${origin}${path}` never doubles.
  return resolved.replace(/\/$/, '');
}

/**
 * Convert dynamic content entries (e.g. blog posts) into sitemap routes.
 *
 * @param entries Content entries to map.
 * @param options Base path / priority / changefreq overrides.
 * @returns One {@link Route} per entry.
 */
export function generateDynamicRoutes(
  entries: DynamicEntry[],
  options: DynamicRouteOptions = {},
): Route[] {
  const basePath = (options.basePath ?? '/blog').replace(/\/$/, '');
  const priority = options.priority ?? '0.7';
  const changefreq = options.changefreq ?? 'monthly';

  return entries.map((entry) => ({
    path: `${basePath}/${entry.slug || entry.id}`,
    priority,
    changefreq,
    lastmod: entry.publishedAt,
  }));
}

/**
 * Build the full sitemap XML document as a string.
 *
 * @param options Origin, static routes and dynamic entries.
 * @returns A complete `urlset` XML document (sitemaps.org 0.9 schema).
 */
export function generateSitemap(options: SitemapOptions = {}): string {
  const origin = resolveOrigin(options.origin);
  const routes: Route[] = [
    ...(options.staticRoutes ?? []),
    ...generateDynamicRoutes(
      options.dynamicEntries ?? [],
      options.dynamicRouteOptions,
    ),
  ];

  // Note: `today` is computed once so every fallback <lastmod> in a single
  // run is consistent, rather than drifting across calls near midnight.
  const today = new Date().toISOString().split('T')[0];

  const urls = routes
    .map((route) => {
      const lastmod = route.lastmod ? toIsoDate(route.lastmod) ?? today : today;
      const loc = `${escapeXml(origin)}${escapeXml(route.path)}`;
      return `  <url>
    <loc>${loc}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${escapeXml(route.changefreq)}</changefreq>
    <priority>${escapeXml(route.priority)}</priority>
  </url>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap-0.9">
${urls}
</urlset>`;
}

/**
 * Generate the sitemap and write it to disk.
 *
 * @param outputPath Absolute or relative file path for the XML output.
 * @param options Same options as {@link generateSitemap}.
 * @returns The number of routes written.
 */
export function writeSitemap(
  outputPath: string,
  options: SitemapOptions = {},
): number {
  const sitemap = generateSitemap(options);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, sitemap, 'utf8');

  const routeCount =
    (options.staticRoutes?.length ?? 0) +
    (options.dynamicEntries?.length ?? 0);
  if (routeCount > MAX_URLS_PER_SITEMAP) {
    // eslint-disable-next-line no-console -- build-time script feedback
    console.warn(
      `Warning: ${routeCount} URLs exceeds the sitemap limit of ` +
        `${MAX_URLS_PER_SITEMAP}. Split into a sitemap index to stay valid.`,
    );
  }
  // eslint-disable-next-line no-console -- build-time script feedback
  console.log(`Sitemap generated at ${outputPath}`);
  // eslint-disable-next-line no-console -- build-time script feedback
  console.log(`Total routes: ${routeCount}`);
  return routeCount;
}
