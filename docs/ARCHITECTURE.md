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

Every component has an adjacent README covering its local contract:

- purpose
- public inputs and outputs
- dependencies and required adapters
- side effects and persistence guarantees
- validation, limits, and error behavior
- tests and known limitations
- adoption steps

Maturity is deliberately centralized in `components.json` so a stale sidecar
cannot contradict the release gate.

Production-ready components are exported by their language package or module.
Reference and experimental components remain available as source but are not
part of the stable TypeScript package surface.

## Stateful workflow conventions

Durable workflows use application-supplied store interfaces. Where multiple
workers can race, the interface requires atomic claims and fencing tokens.
Where providers can replay requests or webhooks, the component uses durable
idempotency identities and validates that a replay still represents the same
operation.

An interface is not a database implementation. Consumers must implement its
documented transaction and uniqueness guarantees in their chosen store.

## Provider integration conventions

Provider adapters:

- accept credentials and network functions through configuration
- validate provider origins and response shapes
- bound request time and response size
- preserve provider idempotency identifiers where supported
- expose provider failures without leaking credentials or unbounded bodies

Webhook components authenticate the exact raw bytes before parsing.

## Release boundary

The TypeScript package contains only production-ready components. The
repository release also includes reference and experimental source, clearly
classified in `components.json`. Git tags and GitHub releases identify tested
repository snapshots; component maturity may only be promoted through a
verified change.
