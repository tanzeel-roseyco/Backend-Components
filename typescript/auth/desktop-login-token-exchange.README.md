# Desktop login token exchange

This component lets a desktop application exchange a short-lived browser login code for an existing web session token.

## Using it

Implement `DesktopLoginStore` with atomic reads for desktop-login and session records, then call `exchangeDesktopLoginCode`. A Next.js route can delegate to `handleDesktopLoginExchange`. Codes must match `CODE_PATTERN`, and both the login record and referenced session must still be valid.

The function deliberately returns `{ token: null }` for invalid, missing, incomplete, expired, or revoked exchanges. That keeps a polling client from learning which validation failed.

## Limits

The module does not create login codes, attach sessions to them, consume successful codes, or rate-limit polling. Those operations belong in the injected store and calling application.
