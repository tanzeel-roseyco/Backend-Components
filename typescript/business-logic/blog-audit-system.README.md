# Blog audit system

This CommonJS module provides two small serverless handlers for reviewing draft blog metadata and publishing selected posts in Supabase.

## Behavior

`list` accepts GET, reads selected fields from draft posts, and orders them by title. `update` accepts POST and either updates one allowed audit field on one draft or bulk-sets selected IDs to `published`. The allowed single-field columns are `niche`, `audit_status`, and `audit_notes`.

## Configuration and outputs

Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Both handlers return serialized JSON with explicit HTTP status codes. The list response is `{ posts }`; successful updates return `{ success: true }` and bulk publishing also reports the submitted ID count.

## Reusing it

Keep it on the server, confirm the `blog_posts` schema, and wrap both handlers in real administrator authentication and authorization. Restrict the service-role credential to the deployment environment.

## Errors, safety, and limitations

The field allowlist prevents arbitrary column names in single updates, and that path only matches drafts. Malformed JSON and missing fields return 400. Database errors are returned, with some provider messages exposed to the caller. Bulk IDs are only checked as a non-empty array; their types and maximum count are not validated. There is no authentication, concurrency control, confirmation gate, or dedicated test file.
