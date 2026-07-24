# Implementation Status

## Current state

The repository contains 63 implementation artifacts: 52 TypeScript, 9 Python,
1 Go, and 1 reusable SQL/RLS component. Nineteen TypeScript components and the
Go rate limiter currently meet the production-ready release standard. Remaining
components are explicitly classified as reference or experimental in
`components.json` rather than being presented as equally verified.

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

- TypeScript strict build, typecheck, ESLint 9, package import, and controlled
  tarball checks run in Docker
- Node integration/unit suite: 173 passing tests
- Python 3.12 package: Ruff, strict mypy, and 19 pytest tests pass in Docker
- Go 1.24 module: `go vet` and race-enabled tests pass in Docker
- registry policy: 8 tests and exact coverage of all 63 implementations
- dependency audit reports zero TypeScript vulnerabilities
- Supabase Postgres Docker verification: 11/11 pgTAP assertions
- RLS down migration applied successfully twice
- package root import and explicit production subpath exports verified
- component registry covers every implementation exactly once
- repository scan contains no prohibited anchor markers

GitHub CI and CodeQL workflows enforce these language and database gates on
`main`. Dependency updates, ownership, issue forms, release notes, repository
topics, maturity labels, secret scanning, push protection, and security updates
are configured through GitHub-native features.

Exact source paths and deduplication decisions are recorded in
`BORROW-INVENTORY.md`.
