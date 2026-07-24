# TypeScript and JavaScript components

This directory contains 52 server-side or reusable TypeScript and JavaScript
components. They are source files, not one application. Some use framework or
provider packages that must be installed by the adopting project.

The directories separate authentication, API middleware, business workflows,
database access, infrastructure code, external integrations, and utilities.
Each production source file has an adjacent README with its actual contract and
dependencies.

## Core subset

`core-files.txt` lists the 19 components covered by the current strict build,
lint configuration, and focused Node test suite. Run those checks from this
directory:

```sh
npm install
npm run build
npm run typecheck
npm run lint
npm run test:core
```

The same checks can run in Docker from the repository root:

```sh
docker build -f typescript/Dockerfile.test -t backend-components-test typescript
docker run --rm backend-components-test
```

## Older components

Components outside `core-files.txt` remain available for reuse, but they do not
all share the core test harness. Read the sidecar README and source before
copying one. In particular, check its imports, environment variables, expected
database tables, and runtime assumptions.

## Copying a component

Copy the source, its sidecar README, and its focused test when one exists.
Replace the supplied storage or provider ports with adapters from the
destination application. Do not copy secrets or assume that a provider webhook,
OAuth client, database schema, or account permission is configured.
