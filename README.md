# Backend Components

This repository is a working library of backend and server-side components for
people who want to reuse them in their own projects, including projects they
have not started yet. The code is organized by language and responsibility so a
developer can take one component without adopting the rest of the repository.

The library currently contains TypeScript and JavaScript modules, Python
modules, one Go package, and a PostgreSQL row-level-security example. The
components cover authentication, external service integrations, workflow
state, file handling, commerce, scheduling, data access, and small backend
utilities.

This is source code, not a hosted service or a single installable application.
Each component still needs to be wired to the storage, credentials, network
clients, and runtime used by the project that adopts it.

## Finding a component

Components live in these directories:

- `typescript/auth`: authentication and token handling
- `typescript/api-middleware`: request middleware and API helpers
- `typescript/business-logic`: reusable workflows and domain logic
- `typescript/database`: database clients and persistence helpers
- `typescript/infrastructure`: leases, transfer jobs, action queues, and network safeguards
- `typescript/integrations`: adapters for external APIs
- `typescript/utilities`: focused helpers with no application shell
- `python`: Python versions of rate limiting, market-data, signing, and utility code
- `go`: a Go rate limiter
- `shared/sql`: PostgreSQL tenant-isolation migration, tests, and rollback

Every production component has a README beside its source file. That README
describes the component's real inputs, dependencies, side effects, errors,
tests, and known limits. Start there before copying a file.

The full provenance record is in [BORROW-INVENTORY.md](BORROW-INVENTORY.md).
[IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md) records the current
verification results.

## Current scope

There are 63 production implementation artifacts in the repository:

- 52 TypeScript or JavaScript components
- 9 Python components
- 1 Go component
- 1 PostgreSQL tenant-isolation component

Twenty of those capabilities were standardized in the latest reuse pass. They
include DocuSign, Dotloop, Twilio conference calls, Google Workspace, Gotenberg,
Stripe, Telegram intake, portable authentication, file-transfer reconciliation,
agent action handling, AI cost controls, lead sequences, abandoned-cart
recovery, quote document workflows, and tenant RLS.

The DocuSign adapter and signed-document processor are present now. More
document-signing adapters for external providers are still in the queue. They
are not part of the current repository and are not counted above.

The GDPR erasure candidate was deliberately excluded and is not implemented.

## Reusing a component

1. Read the README beside the source file.
2. Copy the component and any types or helpers named in that README.
3. Supply the required adapters and environment values from your application.
4. Copy or recreate the focused tests in the destination project.
5. Run the destination project's lint, typecheck, unit, and integration checks.

Do not assume that copying a component makes its external service work. Provider
accounts, webhook registration, database tables, permissions, and secrets remain
the responsibility of the adopting project.

## TypeScript checks

The core TypeScript subset uses Node 22 in Docker:

```sh
docker build -f typescript/Dockerfile.test -t backend-components-test typescript
docker run --rm backend-components-test
```

The package also exposes separate commands from `typescript/`:

```sh
npm run build
npm run typecheck
npm run lint
npm run test:core
```

`test:core` covers the 19 TypeScript components listed in
`typescript/core-files.txt`. Older components outside that manifest do not all
use the same test runner, so the command is not a claim of repository-wide test
coverage.

## PostgreSQL check

The files in `shared/sql` contain:

- the tenant tables, membership helper, grants, and RLS policies
- an 11-assertion pgTAP role matrix
- an idempotent down migration

Run them against a disposable PostgreSQL database with pgTAP installed. The
latest verification used the `supabase/postgres:15.8.1.085` Docker image.

## What is not promised

The repository does not claim that every component is suitable for every
application. It does not provide hosted infrastructure, provider accounts,
database provisioning, or an end-to-end product. A component README may call
out limits that require changes for a particular workload or security model.
