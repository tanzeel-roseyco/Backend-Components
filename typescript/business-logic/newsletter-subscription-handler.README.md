# Newsletter subscription handler

This CommonJS serverless endpoint accepts newsletter and waitlist signups. It can write a Supabase row, add the address to a Kit form, and send subscriber and administrator emails through Resend.

## Request and behavior

POST JSON accepts `email`, optional `name`, `list`, and `source`. Email is validated and free-text fields are capped. The handler attempts the database write first, Kit second, and the two emails last. Waitlist entries use the waitlist form when configured, otherwise the newsletter form.

## Configuration

Set `RESEND_API_KEY`, `CONTACT_TO_EMAIL`, and `CONTACT_FROM_EMAIL` for email. Supabase uses `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Kit uses `KIT_API_KEY`, `KIT_FORM_ID_NEWSLETTER`, and `KIT_FORM_ID_WAITLIST`.

## Reusing it

Create the `subscriptions` table, configure verified email identities and Kit form IDs, then deploy it in a Node serverless runtime with global `fetch`. Add platform-level abuse controls before exposing it publicly.

## Errors and limitations

Database and Kit failures are best-effort and do not stop email attempts. Missing Resend configuration returns 500, and the request succeeds when at least one of the two emails succeeds. HTML fields are escaped. There is no double-opt-in state machine, unsubscribe flow, duplicate handling, authentication, rate limiting, or dedicated test file.
