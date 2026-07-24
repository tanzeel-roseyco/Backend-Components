# TypeScript and JavaScript components

This directory contains 52 server-side or reusable TypeScript and JavaScript
components. They are source files, not one application. Some use framework or
provider packages that must be installed by the adopting project.

The directories separate authentication, API middleware, business workflows,
database access, infrastructure code, external integrations, and utilities.
Each source file has an adjacent README with its actual contract and
dependencies. The repository-level `components.json` file is the authoritative
maturity classification.

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

The package root exposes namespace exports so similarly named provider types do
not collide:

```ts
import { DocuSign, WorkflowLease } from "@backend-components/typescript";
```

Production components can also be imported through documented subpaths. The
package tarball contains only compiled production-ready code, declarations,
this README, and the license.

## Reference and experimental components

Components outside `core-files.txt` remain available for reuse, but they do not
belong to the stable package surface. Read `components.json`, the sidecar
README, and the source before copying one. In particular, check its imports,
environment variables, expected database tables, and runtime assumptions.

## Copying a component

Copy the source, its sidecar README, and its focused test when one exists.
Replace the supplied storage or provider ports with adapters from the
destination application. Do not copy secrets or assume that a provider webhook,
OAuth client, database schema, or account permission is configured.
