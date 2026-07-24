# Code Reviews

## Core standardisation batch

Scope: spam-submission guard, secret redaction, workflow leases, and focused tests.

- Reviewed implementation and test lines: 339
- Defects reported across review iterations: 23
- Severity: 10 high, 10 medium, 3 low
- Defect density: 6.78 defects per 100 reviewed lines
- Final result: PASS from the utilities/security reviewer and the lease-design reviewer

The review loop corrected incomplete secret masking, provider-specific email
normalisation, false-positive spam heuristics, caller-controlled lease clocks,
missing fencing, stale-release and forgery risks, mutable authority state, TTL and
date bounds, renewal behaviour, runtime validation, and boundary-test gaps.

Formatting and styling were left to automated tooling rather than review agents.

## Consolidated organisation borrow wave

Scope: 19 TypeScript modules, their focused tests, and the tenant-RLS migration,
pgTAP suite, and down migration. Reviews were split into chunks of at most 200
lines. Separate reviewers covered implementation correctness, security,
idempotency, concurrency, storage transitions, timeout/resource behavior, and
deep design tradeoffs. Formatting remained an automated lint responsibility.

- Unique implementation and test lines reviewed: 11,048
- Defects reported and fixed across adversarial iterations: 185
- Iterative defect density: 1.67 defects per 100 unique reviewed lines
- Final open defects: 0
- Final result: PASS after fix-and-re-review convergence

Material corrections included DNS socket pinning, hard deadlines that tolerate
ignored aborts, non-blocking cleanup, tenant/account scoping, request fingerprints,
provider idempotency, fenced renewable leases, immutable input snapshots, OAuth
state limits, strong JWK validation, monotonic refund evidence, atomic webhook and
outbox transitions, fixed-point cost accounting, prototype-safe canonical JSON,
RLS privilege convergence, and reversible migration coverage.

Final zero-defect reviews covered DocuSign, Dotloop, Stripe, Google Workspace,
Twilio Voice, portable auth, signed documents, agent actions, file transfer, AI
cost control, lead sequences, abandoned carts, quote documents, Telegram intake,
Gotenberg, SSRF-safe downloads, and tenant RLS. The SQL review also verified the
11-case role matrix and an idempotent down migration.
