# Calendly webhook handler

This CommonJS module handles Calendly invitee-created and invitee-cancelled webhooks in a Netlify-style runtime.

## Behavior

The handler optionally verifies the raw body signature before parsing it. Created events are mapped to a booking record, then independently written to Supabase, removed from nurture activity, and reported by email. Cancelled events update the matching Calendly event ID and send an administrator email. Dependencies can be supplied through `createHandler()` for testing or reuse.

## Configuration

Signature and behavior use `WEBHOOK_SIGNING_SECRET`, `BOOKINGS_TABLE`, `EMAIL_FROM`, `ADMIN_EMAIL`, and `PUBLIC_SITE_URL`. Default integrations additionally read Supabase, email, and nurture API environment settings shown in the source.

## Reusing it

Set a signing secret, retain the untouched request body, align the bookings table with `toBookingRecord()`, and inject or configure the three optional integrations. Confirm the exact signature header and algorithm against the current Calendly webhook contract.

## Errors and limitations

Bad configured signatures return 401 and malformed processing returns 500. After verification, provider side effects are best-effort and a well-formed recognized or unrecognized event returns 200. If no signing secret is configured, signature verification is skipped. There is no durable event-id deduplication or dedicated test file.
