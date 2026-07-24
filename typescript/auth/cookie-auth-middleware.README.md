# Cookie authentication middleware

This module issues and verifies signed authentication tokens carried in cookies. It can also revoke a token for the lifetime of the running process and provides a middleware wrapper for request handlers.

## Using it

Construct `CookieAuthMiddleware` with a secret of at least 32 characters. Optional settings control the cookie name, expiry, `Secure`, `HttpOnly`, and `SameSite` attributes. Call its token and cookie methods from the framework adapter in your application, or use `createAuthMiddleware`.

Successful verification returns an authenticated result with a user ID. Invalid, expired, malformed, or blacklisted tokens return an unauthenticated result. Signatures use Node's crypto library.

## Limits

Cookie creation and clearing currently hardcode `Domain=localhost`. Change that domain before using the component on another host.

The blacklist is an in-memory `Set`; revocations do not survive a restart and are not shared between processes. This is not a session database. Add a shared revocation store before using it across multiple instances.
