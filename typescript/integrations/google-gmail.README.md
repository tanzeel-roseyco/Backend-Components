# Gmail message reader

This component lists Gmail messages matching a query or label and turns each fetched message into a compact summary containing selected headers, plain-text body content, and calendar attachments.

## Using it

Implement `OAuthTokenStore`, link a Google account with a refresh token, and set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Create a client with `getGoogleGmailClient`, then call `listGmailMessages` with query, label, date, page, and body-size options.

Refreshed credentials are persisted through the store. Individual message fetch failures are logged and skipped so a batch can continue.

## Limits

This is read-only ingestion. It prefers plain-text MIME parts and does not attempt full HTML rendering. Bodies are truncated to a configurable limit, and silently skipped messages must be accounted for by callers that require complete ingestion.
