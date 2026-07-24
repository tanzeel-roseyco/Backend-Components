# Prisma client singleton

This module exports one Prisma client using the PostgreSQL driver adapter. In development it caches the client on `globalThis` so hot reloads do not repeatedly create connection pools.

## Using it

Install `@prisma/client` and `@prisma/adapter-pg`, generate a compatible Prisma client, and set `DATABASE_URL`. Import the exported `prisma` instance wherever database access is needed.

The module fails during initialization when `DATABASE_URL` is missing. Production creates one client for the loaded module; only non-production environments use the global cache.

## Limits

The import assumes the standard generated `@prisma/client` path. Projects with a custom generator output must change that import. Connection limits and shutdown behavior remain Prisma and driver configuration concerns.
