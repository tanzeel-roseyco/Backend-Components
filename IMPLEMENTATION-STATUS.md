# Implementation Status

## Current state

The repository contains 52 production implementation artifacts: 41 TypeScript,
9 Python, 1 Go, and 1 reusable SQL/RLS component. The current borrow program
standardized 20 high-value capabilities from the validated ElevateoCo and
TeamRoseyCo inventory while leaving every source repository unchanged.

### Newly standardized capabilities

- spam submission assessment and canonical lead identity
- durable lead sequencing with replay-safe delivery
- DocuSign JWT/envelope/webhook/state integration
- Dotloop OAuth/PKCE/token/loop integration
- signed-document artifact processing
- Gotenberg HTML-to-PDF rendering
- Twilio signature/TwiML/two-leg conference orchestration
- Google OAuth, Drive, resumable upload, and Sheets operations
- resumable cross-store file copy and stranded-transfer reconciliation
- portable PKCE, JWKS JWT verification, and single-use invites
- durable tenant-scoped agent actions with fail-closed policy
- DNS-pinned SSRF-safe HTTPS download
- fixed-point AI cost reservation and replay
- Telegram webhook intake
- Stripe checkout, payment, and cumulative refund evidence
- abandoned-cart recovery
- quote extraction, PDF/Excel rendering, approval, and delivery
- tenant-isolated Postgres RLS with pgTAP and reversible migration
- workflow leases and secret redaction

The GDPR erasure candidate is intentionally excluded by product decision.

## Verification

- strict TypeScript build and no-emit typecheck run in Docker
- ESLint run against every standardized TypeScript component
- Node integration/unit suite run in Docker
- dependency audit reports zero vulnerabilities
- Supabase Postgres Docker verification: 11/11 pgTAP assertions
- RLS down migration applied successfully twice
- adversarial reviews use chunks no larger than 200 lines and include dedicated
  design, security, concurrency, idempotency, timeout, and failure-path passes
- repository scan contains no prohibited anchor markers

Exact source paths and deduplication decisions are recorded in
`BORROW-INVENTORY.md`; review findings and density are recorded in
`code-reviews.md`.
