# SEO URL utilities

This component normalises paths and creates absolute, canonical, and image URLs from a site configuration. It also exposes default site and image values for callers that want a pre-bound set of helpers.

`createSeoUtils` accepts a `SiteConfig`. The default configuration looks for `VITE_SITE_URL`, `SITE_URL`, and `URL`, then falls back to `https://example.com`. Already absolute HTTP or HTTPS URLs pass through unchanged.

The functions return strings and have no I/O. They normalise slashes, but do not validate that caller-supplied origins or paths are safe to place directly in HTML. Use trusted configuration for the origin and escape values at the rendering boundary.

There is no dedicated test file in this repository. Applications should replace the neutral default identity and asset paths before using the default exports in production.
