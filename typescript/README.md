# TypeScript and JavaScript components

This directory contains 52 server-side or reusable TypeScript and JavaScript
components. They are source files, not one application. Some use framework or
provider packages that must be installed by the adopting project.

The directories separate authentication, API middleware, business workflows,
database access, infrastructure code, external integrations, and utilities.
The repository-level `components.json` file is the authoritative maturity
classification. Public types, source comments, and focused tests define
component behavior.

## Core subset

`core-files.txt` lists the 19 production-ready components covered by the strict
build, lint configuration, package entry point, and focused Node test suite.
Run the complete check from this directory:

```sh
npm ci
npm run verify
```

The same checks can run in Docker from the repository root:

```sh
docker build -f typescript/Dockerfile.test -t backend-components-test typescript
docker run --rm backend-components-test
```

## Package use

The package requires Node.js 20 or newer and currently exposes CommonJS
`require` exports. From this repository, build a local package tarball with
`npm pack`, then install that tarball in the adopting project. The package is
not represented here as published to a package registry.

The package root uses namespace exports so similarly named provider types do
not collide:

```ts
const { DocuSign, WorkflowLease } = require("@backend-components/typescript");
```

Production components can also be imported through documented subpaths. The
package uses explicit subpath exports for production-ready components only;
reference and experimental files are not exported as supported package APIs.
The package tarball contains package metadata, the compiled production-ready
surface, declarations, this README, and the license.

## Critical integration constraints

- Twilio signature verification requires the exact public URL and submitted
  form parameters. Configure a trusted public origin; do not reconstruct it
  from untrusted forwarding headers.
- DocuSign webhook verification requires the exact request bytes. Envelope
  creation also requires an application-owned durable idempotency store.
- Resumable transfer store writes must enforce the current lease token and
  fencing identity atomically. The included component does not provide a
  database or object-store adapter.

## Reference and experimental components

Components outside `core-files.txt` remain available for reuse, but they do not
belong to the stable package surface. Read `components.json` and the source
before copying one. In particular, check its imports, environment variables,
expected database tables, and runtime assumptions.

## Copying a component

Copy the source and its focused test when one exists. Replace the supplied
storage or provider ports with adapters from the destination application. Do
not copy secrets or assume that a provider webhook, OAuth client, database
schema, or account permission is configured.
