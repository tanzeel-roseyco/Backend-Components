# HMAC email tokens

This component signs a normalised email address with HMAC-SHA256 and returns the first 32 hexadecimal characters. Verification recomputes the value and uses Node's constant-time buffer comparison.

The secret is passed by the caller and must contain at least 32 characters. `sign` throws for a short secret; `verify` returns `false` for malformed input, short secrets, or verification errors. Tokens do not contain an expiry, audience, purpose, or list identifier, so those constraints must be included separately if the same secret serves more than one operation.

`createUnsubscribeHandlers` supplies framework-shaped GET and POST examples. The POST handler verifies the token but does not actually remove an address from a mailing list; that integration remains a clearly marked placeholder. The handlers also use `any` request and response types.

There is no dedicated test file in this repository.
