# Google Search Console client

This read-only adapter queries Search Console search analytics with typed dimensions, date ranges, country filters, and row limits.

## Using it

Supply service-account credentials and a verified property URL through constructor options or `GOOGLE_SERVICE_ACCOUNT_KEY` and `GSC_SITE_URL`. The credential value may be inline JSON or a key-file path. Call the exported client methods to request analytics rows.

Authentication is restricted to the `webmasters.readonly` scope. The module waits for an authenticated Google client before each query and maps API rows into a stable result shape.

## Limits

The service account must already have access to the Search Console property. This module does not manage property membership, pagination beyond its exposed row controls, caching, or quota retries.
