# Search Console ranking tracker

This scheduled Node component reads Search Analytics rows from Google Search Console and upserts them into a Supabase `ranking_history` table in batches. It exports the core sync function, the batch-upsert helper, and a Netlify-compatible handler scheduled for 06:00 UTC when the Netlify package is available.

Required environment variables are `GOOGLE_SERVICE_ACCOUNT_KEY`, `GSC_SITE_URL`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`. Optional settings include `GSC_COUNTRY_FILTER` and `RANKING_BATCH_SIZE`. The service-account JSON must represent an account with access to the configured Search Console property.

The default query uses a 28-day window ending three days behind the run date and asks for at most 25,000 rows. Writes use a composite conflict key expected to exist in the database. The service-role key must stay in a server runtime.

Failures are logged and become a 500 response from the handler. This repository does not include the table migration, Google property setup, or a dedicated test for this component.
