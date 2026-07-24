# DocuSign client

This module covers a focused DocuSign workflow: loading validated configuration, obtaining JWT-grant access tokens, creating template envelopes, reading envelope status, verifying Connect webhook signatures, and advancing a seller-document state through an injected store.

## Using it

Provide approved DocuSign account, integration, user, API base URL, RSA private key, and webhook secrets through the documented environment keys and `loadDocuSignConfig`. Construct `DocuSignClient` with an idempotency store before creating envelopes. Feed exact webhook bytes and signature headers to the verification and seller-status functions.

Requests have size and time bounds. Envelope creation is tenant-scoped and request-hashed so reuse of an idempotency key with different content is rejected.

## Tests

`docusign-client.test.js` covers configuration, token exchange, regional endpoints, envelope replay, response validation, webhooks, state transitions, and timeouts.

## Limits

This is not a complete embedded-signing product. Recipient views, template administration, consent screens, webhook HTTP routing, and a concrete durable store are not included.
