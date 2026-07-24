# Repository architecture

## Purpose

Backend Components is a source library for engineers who want to reuse a
bounded backend capability without adopting an entire application. It is not a
framework, hosted platform, or application template.

## Organization

The repository is organized first by runtime and then by responsibility:

```text
typescript/
  auth/             authentication and authorization primitives
  business-logic/   provider-neutral workflows
  infrastructure/   durability, concurrency, transfer, and network primitives
  integrations/     external-provider adapters
  utilities/        focused stateless helpers
python/              Python components and their package/test configuration
go/                  Go module and package tests
shared/sql/          database policies, migrations, and database-native tests
```

Physical location does not imply production readiness. `components.json` is
the authoritative, machine-readable maturity registry.

## Dependency direction

```text
adopting application
        |
        v
workflow or domain component
        |
        v
small injected ports
        |
        v
application-owned storage and provider adapters
```

Business rules define what must happen. Provider clients define how an external
API is called. Storage interfaces define the atomic guarantees a workflow
requires, but the adopting application chooses PostgreSQL, Redis, a queue, or
another durable implementation.

This direction keeps reusable policy independent of Next.js, Express,
Supabase, Prisma, and provider SDK release cycles.

## Component contract

Public types define each component's callable surface. Source comments and
focused tests record verified behavior and operational constraints. Consumers
must review those tests and implement application-owned adapters with the
atomicity, uniqueness, and retry behavior their deployment requires. Maturity
is centralized in `components.json`.

Production-ready components are exported by their language package or module.
Reference and experimental components remain available as source but are not
part of the stable TypeScript package surface.

## Stateful workflow conventions

Durable workflows use application-supplied store interfaces. Those interfaces
require component-specific atomicity and idempotency and, where exposed,
fencing semantics recorded in their public contracts and tests. Where
providers can replay requests or webhooks, the component uses durable
idempotency identities and validates that a replay still represents the same
operation.

An interface is not a database implementation. Consumers must establish and
test the transaction, uniqueness, fencing, and retry guarantees required by
their chosen store.

## Provider integration conventions

Provider adapters:

- accept credentials and network functions through configuration
- validate provider origins and response shapes
- bound request time and response size
- preserve provider idempotency identifiers where supported
- expose provider failures without leaking credentials or unbounded bodies

Webhook components preserve the provider-specific signed representation before
parsing or normalization. Depending on the provider, that may be raw bytes, a
secret header, or the exact public URL and submitted form fields.

## Release boundary

The TypeScript package contains only production-ready components. The
repository release also includes reference and experimental source, clearly
classified in `components.json`. Git tags and GitHub releases identify tested
repository snapshots; component maturity may only be promoted through a
verified change.
