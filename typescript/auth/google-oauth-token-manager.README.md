# Google OAuth token manager

This module creates an authenticated Google OAuth client for a linked account and keeps refreshed credentials in an application-provided token store.

## Using it

Implement `TokenStore`, provide an account identifier, and construct `GoogleOAuthTokenManager`. Client ID and secret can be passed explicitly or read from `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`; the redirect URI is optional. The manager loads stored credentials, attaches the refresh listener before refresh can occur, and refreshes tokens that are near expiry.

It returns authenticated Google API clients and persists rotated access or refresh tokens through the store. Missing accounts, missing refresh tokens, and refresh failures are reported as errors.

## Limits

It does not implement the browser consent flow or choose OAuth scopes. Storage consistency and encryption of persisted credentials are the caller's responsibility.
