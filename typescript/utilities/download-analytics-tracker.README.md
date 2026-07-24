# Download analytics tracker

This CommonJS serverless handler records a resource-download event in Supabase. Stored fields include the title and URL, optional name and email, traffic source, client IP, and user agent. The persistence function and IP extraction helper are exported separately for reuse.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` configure the database. `DOWNLOADS_TABLE` optionally replaces the default `audio_downloads` table. The handler accepts a Lambda/Netlify-style event and returns JSON-shaped HTTP responses.

The service-role credential must remain server-side. The stored record can contain personal data, and forwarding headers are only reliable behind a trusted proxy. Inserts are not assigned an idempotency key, so client retries may create duplicate rows. Database failures return 500; successful or intentionally skipped writes return 200.

The table schema and a dedicated test are not included in this repository.
