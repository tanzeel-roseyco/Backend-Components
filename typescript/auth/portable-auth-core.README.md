# Portable authentication core

This dependency-light module contains three server-side authentication building blocks: PKCE transaction creation and one-time consumption, JWKS-backed JWT verification, and single-use invite tokens.

## Using it

Provide atomic implementations of `PkceTransactionStore` and `InviteClaimStore`. Configure `JwksJwtVerifier` with approved issuers, audience, algorithms, an HTTPS JWKS URL, and a fetcher. The functions return PKCE material, verified JWT claims, or claimed invite data.

The implementation validates sizes, URLs, token formats, timestamps, issuer and audience claims, RSA key strength, response size, and duplicate JWKS keys. PKCE state and invite tokens are stored as hashes rather than plaintext.

## Tests

`portable-auth-core.test.js` covers successful flows and malformed, expired, replayed, oversized, and cryptographically invalid inputs.

## Limits

Only the algorithms accepted by the configured verifier can be used. Stores, HTTP routing, cookies, and user records are intentionally outside this module.
