# Serverless HTTP helpers

These CommonJS helpers cover recurring work in Lambda-proxy and Netlify-style handlers: HTML escaping, case-insensitive header lookup, best-effort client-IP and user-agent extraction, JSON responses, and HTTP method checks.

The functions operate on event objects with `httpMethod`, `headers`, and `body`-style fields. `assertMethod` returns `null` for an accepted method or a ready-to-return 405 response. `jsonResponse` serialises its body and supplies JSON headers.

Proxy headers are accepted as supplied, so the client IP is trustworthy only when the deployment platform removes user-forged forwarding headers. `escapeHtml` is for HTML text interpolation; it is not a general URL, SQL, JavaScript, or CSS sanitizer.

The module has no runtime dependencies, configuration, state, or dedicated tests in this repository.
