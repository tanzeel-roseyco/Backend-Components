/**
 * SEO Utilities — URL canonicalization, path normalization, and default social/image constants.
 *
 * Purpose:
 *   Provides small, dependency-free helpers to turn app-relative paths into
 *   canonical absolute URLs against a single configured site origin, plus
 *   derived default Open Graph / social + logo image URLs. Intended for
 *   generating <link rel="canonical">, og:image, and og:url tags.
 *
 * Required env vars (all optional; each falls back to the next, then to a neutral default):
 *   - VITE_SITE_URL : Site origin when running under Vite (import.meta.env).
 *   - SITE_URL      : Site origin under Node/SSR (process.env).
 *   - URL           : Generic origin fallback (e.g. platform-injected, like Netlify/Vercel).
 *   Configure the site name and image paths via the `SiteConfig` passed to
 *   `createSeoUtils`, or rely on the exported defaults which read the env vars above.
 *
 * Key dependencies: none (pure standard library / platform globals only).
 *
 * Note: Adapted and generalized from a production codebase. Originally this
 *   split logic across a `seo.ts` module and a `config/site.ts` module with a hardcoded
 *   production origin, brand name, and image paths; those have been inlined here and
 *   generalized into env vars + a `SiteConfig` options object so the module is self-contained
 *   and carries no client/personal identity.
 * Note: Ordering constraint — the site origin must be resolved (env → default) BEFORE
 *   any absolute/canonical/image URL is built; `absoluteUrl` returns already-absolute inputs
 *   unchanged so external image/social URLs pass through without being re-prefixed.
 * Note: Security — never interpolate untrusted, unvalidated strings into `origin`.
 *   The origin should come only from trusted env/config; user-supplied paths are normalized
 *   but not otherwise sanitized for injection into HTML (escape at the render layer).
 */

// Note: Original imports (internal, not included in this public copy):
//   import { SITE, SITE_ORIGIN } from '../config/site';
// The config module's behavior is inlined below via `resolveSiteOrigin` + `SITE`.

/** Configuration describing the site's identity and default asset paths. */
export interface SiteConfig {
  /** Absolute site origin, e.g. "https://example.com" (no trailing slash required). */
  readonly origin: string;
  /** Human-readable site/brand name. */
  readonly name: string;
  /** Short/abbreviated site name for compact UI or badges. */
  readonly shortName: string;
  /** App-relative (or absolute) path to the default social sharing image. */
  readonly defaultSocialImage: string;
  /** App-relative (or absolute) path to the site logo image. */
  readonly logoImage: string;
}

/** The subset of SEO helpers bound to a specific {@link SiteConfig}. */
export interface SeoUtils {
  readonly site: SiteConfig;
  readonly normalizePath: (path?: string) => string;
  readonly absoluteUrl: (path?: string) => string;
  readonly canonicalUrl: (path?: string) => string;
  readonly imageUrl: (path?: string) => string;
  readonly defaultSocialImage: string;
  readonly defaultLogoImage: string;
}

/**
 * Returns true if `value` is an absolute http(s) URL and therefore must not be
 * re-prefixed with the site origin.
 */
const isAbsoluteHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

/**
 * Normalizes an app-relative path: guarantees a single leading slash and
 * collapses any runs of consecutive slashes into one.
 *
 * @param path - The path to normalize. Defaults to the site root "/".
 * @returns A path beginning with exactly one "/" and no "//" sequences.
 * @example normalizePath('foo//bar') // => "/foo/bar"
 */
export const normalizePath = (path: string = '/'): string => {
  if (!path || path === '/') return '/';
  const withLeadingSlash = path.startsWith('/') ? path : `/${path}`;
  // Collapse duplicate slashes (e.g. from naive path joins) into a single slash.
  // Note: This collapses ALL "//" runs anywhere in the string, so it must only
  //   receive bare paths — a query string carrying a URL (e.g. "/r?to=https://x")
  //   would be corrupted to "https:/x". Pass such values through absoluteUrl's
  //   isAbsoluteHttpUrl guard, or build them after normalization, not before.
  return withLeadingSlash.replace(/\/{2,}/g, '/');
};

/**
 * Resolves the site origin from environment variables, falling back to a
 * neutral placeholder. Reads Vite's `import.meta.env` first, then Node's
 * `process.env`, then a platform-injected `URL`, then the placeholder.
 *
 * @param fallbackOrigin - Origin to use when no env var is set.
 * @returns The origin with any trailing slashes stripped.
 */
export const resolveSiteOrigin = (fallbackOrigin: string = 'https://example.com'): string => {
  // Note: `import.meta` access is guarded so this module also works under
  //   plain Node/CommonJS transpilation where `import.meta.env` is undefined.
  const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  const nodeEnv = runtime.process?.env;

  const configuredOrigin =
    viteEnv?.VITE_SITE_URL ||
    nodeEnv?.SITE_URL ||
    nodeEnv?.URL ||
    fallbackOrigin;

  return configuredOrigin.replace(/\/+$/, '');
};

/**
 * Default, neutral site configuration. The origin is resolved from env vars at
 * module load; name/image values are generic placeholders. Override per project
 * by calling {@link createSeoUtils} with your own {@link SiteConfig}.
 */
export const SITE: SiteConfig = {
  origin: resolveSiteOrigin(),
  name: 'Example Co',
  shortName: 'Example',
  defaultSocialImage: '/images/social-default.jpg',
  logoImage: '/images/logo.jpg',
} as const;

/**
 * Builds SEO URL helpers bound to a given site configuration.
 *
 * @param config - Site identity + default asset paths. Defaults to {@link SITE}.
 * @returns A {@link SeoUtils} bundle whose URL helpers resolve against `config.origin`.
 */
export const createSeoUtils = (config: SiteConfig = SITE): SeoUtils => {
  const origin = config.origin.replace(/\/+$/, '');

  /**
   * Converts an app-relative path into an absolute URL. Inputs that are already
   * absolute http(s) URLs are returned unchanged.
   */
  const absoluteUrl = (path: string = '/'): string => {
    if (isAbsoluteHttpUrl(path)) return path;
    return `${origin}${normalizePath(path)}`;
  };

  return {
    site: config,
    normalizePath,
    absoluteUrl,
    // canonicalUrl and imageUrl are semantic aliases of absoluteUrl; distinct
    // names document intent at call sites (canonical link vs og:image).
    canonicalUrl: absoluteUrl,
    imageUrl: absoluteUrl,
    defaultSocialImage: absoluteUrl(config.defaultSocialImage),
    defaultLogoImage: absoluteUrl(config.logoImage),
  };
};

// Default-config helpers exported for convenience (mirror the original module's surface).
const defaultUtils = createSeoUtils(SITE);

/** Convert an app-relative path to an absolute URL against the default site origin. */
export const absoluteUrl = defaultUtils.absoluteUrl;
/** Alias of {@link absoluteUrl}; use for <link rel="canonical"> hrefs. */
export const canonicalUrl = defaultUtils.canonicalUrl;
/** Alias of {@link absoluteUrl}; use for og:image / image asset URLs. */
export const imageUrl = defaultUtils.imageUrl;

/** Absolute URL of the default social sharing image (from {@link SITE}). */
export const DEFAULT_SOCIAL_IMAGE = defaultUtils.defaultSocialImage;
/** Absolute URL of the default logo image (from {@link SITE}). */
export const DEFAULT_LOGO_IMAGE = defaultUtils.defaultLogoImage;
