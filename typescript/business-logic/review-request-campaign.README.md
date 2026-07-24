# Review request campaign

This CommonJS module runs a post-booking email campaign and exposes a Netlify/AWS Lambda-style HTTP handler.

## Behavior

It selects completed bookings older than a configurable delay, optionally narrows the run to supplied booking IDs, chooses a review destination from location rules, and sends through Resend. After a successful send it marks the booking as sent. The run is capped to limit each invocation. The HTTP handler accepts POST, requires the campaign token in the `Authorization` header, permits an optional `Bearer` prefix, and accepts an ID array or `"all-eligible"`.

## Configuration and data

The implementation reads `EMAIL_API_KEY`, `DB_URL`, `DB_SERVICE_ROLE_KEY`, `CONTACT_FROM_EMAIL`, `SOCIAL_REVIEW_URL`, and `CAMPAIGN_AUTH_TOKEN`. It uses Resend and Supabase and expects booking identity, customer, location, status, timestamps, and review-request state columns.

## Reusing it

Replace the illustrative location rules and links, confirm the table schema, configure verified sending addresses, and call `runReviewCampaign` from a trusted job or deploy `handler` behind HTTPS.

## Errors, safety, and limitations

The HTTP entry point fails closed when its trigger token is absent. Customer values are escaped before HTML interpolation. Database reads and sends can partially succeed; the sent flag is only updated after delivery. There is no transaction spanning provider delivery and the database update, so a crash between them can lead to a repeated send. No dedicated test file accompanies this module.
