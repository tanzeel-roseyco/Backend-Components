# Blog post notification

This CommonJS serverless handler creates an email-provider broadcast for one published blog post loaded from Supabase.

## Behavior

POST JSON supplies `postSlug`. The handler loads the post, extracts short key points from its content, builds HTML and text versions, adds UTM parameters to the article URL, and creates a private published broadcast through the configured provider endpoint. It returns selected broadcast and post details; it does not issue a separate send command.

## Configuration

The component reads `EMAIL_API_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SITE_URL`, `BRAND_NAME`, `BRAND_TAGLINE`, `BRAND_COLOR`, and optional `TRIGGER_SECRET`.

## Reusing it

Match the expected blog table fields, configure the provider secret and site identity, and put the endpoint behind authentication. Review provider payload semantics before treating the resulting broadcast as a draft or a sent campaign.

## Errors and safety

Methods, request shape, configuration, missing posts, database failures, and provider failures map to HTTP errors. HTML is escaped and the provider secret is not logged. Authentication is enforced only when `TRIGGER_SECRET` is set. The response text says the broadcast is a draft while the provider payload sets `published: true`; verify the provider's meaning before use. No dedicated test file accompanies this module.
