# Quiz assessment handler

This Netlify-style CommonJS handler accepts a quiz result, derives a marketing tag, optionally stores the submission, syncs it to Kit, and sends result and administrator emails through Resend.

## Request and response

POST JSON must include `name`, `email`, `niche`, and a truthy `tier`. Optional fields include `quiz_slug` and consent metadata. The niche is slugged and combined with the tier server-side. Valid requests return HTTP 200 after the three integration stages have been attempted.

## Configuration

Provider settings come from `RESEND_API_KEY`, `KIT_API_KEY`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`. Email copy and destinations also use the documented brand, practitioner, booking, phone, and contact environment variables.

## Reusing it

Deploy it only in a server runtime, create the expected Supabase table, configure the provider accounts, and replace the neutral email copy. Check that the stored consent fields and retention policy match the host application's legal requirements.

## Verified limitations

Storage, Kit sync, and email failures are logged and treated as non-fatal, so HTTP 200 does not prove any side effect succeeded. Tier is not restricted to the three named labels; other truthy values produce a generic label. There is no authentication, rate limiting, replay protection, or dedicated test file.
