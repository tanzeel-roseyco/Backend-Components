# Google Workspace REST client

This dependency-free client uses a refresh token to call selected Google Drive and Sheets REST endpoints. It supports folder lookup and creation, file listing, simple and resumable uploads, file deletion, and spreadsheet value reads and writes.

## Using it

Construct the client with OAuth client ID, client secret, refresh token, and optional fetch, clock, and timeout overrides. Methods accept Drive identifiers, names, upload content, and Sheets ranges and values. Access tokens are cached and simultaneous refreshes are coalesced.

Requests, identifiers, payloads, responses, and time are bounded. Upload input is snapshotted before asynchronous work where needed.

## Tests

`google-workspace-rest.test.js` covers token refresh, Drive and Sheets operations, uploads, validation, response limits, cancellation, and failure responses.

## Limits

The client does not implement OAuth consent, token persistence, sharing permissions, change feeds, or every Drive and Sheets endpoint. Resumable upload recovery across process restarts requires caller-owned persistence.
