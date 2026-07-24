# Backend Components

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

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

The machine-readable [components.json](components.json) classifies every
implementation as `production-ready`, `reference`, or `experimental`.
[docs/MATURITY.md](docs/MATURITY.md) defines those terms. A directory name or
source-file comment does not override the registry.

The same document defines the public grading system: Grade A for stable,
verified package or module surfaces; Grade B for tested reference components;
Grade C for source-only reference components; and Grade D for experimental
work.

[provenance.json](provenance.json) records the source paths used to standardize
borrowed components where path-level provenance is known.

## Current scope

There are 63 implementation artifacts in the repository:

- 52 TypeScript or JavaScript components
- 9 Python components
- 1 Go component
- 1 PostgreSQL tenant-isolation component

Twenty capabilities currently meet this repository's `production-ready`
standard: nineteen TypeScript components and one Go component. They include
DocuSign, Dotloop, Twilio conference
calls, Google Workspace, Gotenberg, Stripe, Telegram intake, portable
authentication, file-transfer reconciliation, agent action handling, AI cost
controls, lead sequences, abandoned-cart recovery, and quote and signed-document
workflows, plus the concurrency-safe Go rate limiter. Other source remains
classified as reference or experimental until it passes the same release gates.

The current document-signing code consists of the DocuSign adapter and the
provider-neutral signed-document processor.

## Reusing a component

1. Check the component's maturity in `components.json`.
2. Read the language README, exported types, source comments, and focused tests
   when they exist.
3. Prefer a stable package export for production-ready TypeScript components.
4. Supply the required adapters and environment values from your application.
5. Copy or recreate the focused tests in the destination project.
6. Run the destination project's lint, typecheck, unit, and integration checks.

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

`test:core` covers the 19 production-ready TypeScript components listed in
`typescript/core-files.txt`. Older components outside that manifest do not all
use the same test runner and are classified accordingly.

The TypeScript package has a working root import and explicit subpath exports.
Only built production-ready components are included in its package tarball.

## Architecture and governance

- [Architecture](docs/ARCHITECTURE.md)
- [Maturity model](docs/MATURITY.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## PostgreSQL check

The files in `shared/sql` contain:

- the tenant tables, membership helper, grants, and RLS policies
- an 11-assertion pgTAP role matrix
- an idempotent down migration

Run them against a disposable PostgreSQL database with pgTAP installed. The
latest verification used the `supabase/postgres:15.8.1.085` Docker image.

## What is not promised

The repository does not claim that every implementation is production-ready or
suitable for every application. It does not provide hosted infrastructure,
provider accounts, database provisioning, or an end-to-end product. Consumers
must verify each component against their workload and security model.
