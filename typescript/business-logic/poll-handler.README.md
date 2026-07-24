# Poll response handler

This CommonJS serverless handler collects one public poll choice, optionally records page and request metadata, and attempts an administrator notification.

## Behavior

POST requests are parsed, trimmed, and capped. A non-empty `choice` is required. The handler inserts into Supabase's `poll_results` table when configured, then sends a Resend email when configured. It returns `saved` and `emailSent` flags alongside `ok: true`.

## Configuration

The database uses `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Email uses `RESEND_API_KEY`, `CONTACT_TO_EMAIL`, and `CONTACT_FROM_EMAIL`. Stored fields are `choice`, `page`, `user_agent`, and `ip_address`.

## Reusing it

Deploy it on a serverless host with the expected event shape and database table. Apply rate limiting and retention rules at the surrounding API or platform layer.

## Errors and safety

Non-POST methods return 405 and missing choices return 400. Database and email errors are logged but deliberately do not fail the valid request; inspect the two result flags instead. User-controlled values are length-bounded and HTML-escaped for email. Forwarded IP headers are untrusted metadata. There is no authentication, bot protection, duplicate prevention, or dedicated test file.
