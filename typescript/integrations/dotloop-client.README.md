# Dotloop client

This client implements Dotloop OAuth authorization with state and PKCE, access-token refresh, and a small set of profile, loop, template, participant, and detail operations.

## Using it

Construct `DotloopClient` with client credentials, an exact redirect URI, scopes, and optional injected transport and clock. Begin authorization, retain the returned transaction through the redirect, and complete it once. The client keeps tokens in memory and refreshes them when needed.

Endpoints are restricted to approved Dotloop origins unless an explicit approved-origin set is supplied. Inputs, response bodies, error text, pending authorization count, and request duration are bounded.

## Tests

`dotloop-client.test.js` covers PKCE, state replay and expiry, refresh concurrency, API operations, malformed responses, origin checks, and timeouts.

## Limits

Tokens and pending authorization transactions are process-local. A production integration must persist encrypted tokens and authorization state if it needs restart safety or multiple instances.
