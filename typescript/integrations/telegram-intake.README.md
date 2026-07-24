# Telegram webhook intake

This component authenticates and parses Telegram bot webhook requests containing a text message or document descriptor, enforces chat and user allowlists, recognizes bot commands, and persists deliveries idempotently.

## Using it

Provide the expected Telegram secret header, bot and integration identifiers, allowed chat and user IDs, document and JSON limits, and an atomic `TelegramUpdateStore`. Call `intakeTelegramWebhook` with the incoming `Request`. Accepted results contain a normalized text or document update.

The handler requires POST with an `application/json` media type, compares secrets in constant time, bounds streamed request bodies, validates Telegram identifiers and file metadata, and fingerprints normalized updates to detect conflicting replays.

## Tests

`telegram-intake.test.js` covers secrets, allowlists, commands, documents, malformed and oversized bodies, duplicate delivery, conflicts, and deadlines.

## Limits

It records Telegram file identifiers but does not download files or call the Bot API. The store must make insert-or-read atomic for reliable deduplication.
