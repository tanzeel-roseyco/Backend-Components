/**
 * Prisma Client Singleton (serverless-safe)
 * =========================================
 *
 * Purpose:
 *   Provides a single, reusable PrismaClient instance backed by the
 *   node-postgres driver adapter (`@prisma/adapter-pg`). In serverless /
 *   hot-reloading environments (e.g. Next.js dev, Lambda, edge runtimes) a
 *   naive `new PrismaClient()` per module load exhausts the database
 *   connection pool. This module caches the client on `globalThis` during
 *   development so repeated module evaluations reuse one client, while
 *   production always creates a fresh, process-scoped client.
 *
 * Required environment variables:
 *   - DATABASE_URL : PostgreSQL connection string (e.g.
 *                    postgresql://user:pass@host:5432/dbname). Never hardcode.
 *   - NODE_ENV     : Controls dev-global caching ("production" opts out).
 *
 * Key dependencies:
 *   - @prisma/client (or a generated client) : the PrismaClient constructor.
 *   - @prisma/adapter-pg                      : node-postgres driver adapter.
 *
 * Note: Adapted and generalized from a production codebase.
 *   Ordering/security constraints:
 *   - DATABASE_URL is the ONLY source of DB credentials; keep it in env, never
 *     in source or logs. It is read at client-creation time.
 *   - The dev-global cache MUST be gated on NODE_ENV !== "production" so
 *     production never leaks a client across process/module boundaries.
 *   - The `as any` cast bridges older generated-client typings that don't yet
 *     expose `adapter` in their constructor options; safe because the adapter
 *     option is validated by Prisma at runtime.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Note: In the source repo the client was imported from a locally
// generated path ("@/generated/prisma/client"). For a portable, self-contained
// component we import from the published "@prisma/client" package instead.
// If you use a custom generator output, swap the import above accordingly.
// import { PrismaClient } from "@/generated/prisma/client";

/**
 * Global slot used to cache the Prisma client across module reloads in
 * development. Typed narrowly so we don't pollute the real `globalThis` type.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * Creates a new PrismaClient wired to PostgreSQL via the node-postgres adapter.
 *
 * Reads the connection string from `process.env.DATABASE_URL`. Throws early if
 * it is missing so misconfiguration fails loud rather than surfacing as an
 * opaque connection error later.
 *
 * @returns A configured {@link PrismaClient} instance.
 * @throws {Error} If `DATABASE_URL` is not set.
 */
function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Provide a PostgreSQL connection string via env."
    );
  }

  const adapter = new PrismaPg({ connectionString });

  // Note: `as any` bridges generated-client typings that may not declare
  // the `adapter` constructor option yet. Prisma validates it at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (PrismaClient as any)({ adapter }) as PrismaClient;
}

/**
 * Shared PrismaClient singleton.
 *
 * Reuses the dev-cached client when present (avoids connection exhaustion on
 * hot reload); otherwise creates a fresh client.
 */
export const prisma: PrismaClient =
  globalForPrisma.prisma ?? createPrismaClient();

// Cache on the global object only outside production so dev hot-reloads reuse
// one client. Production intentionally keeps the client process-scoped.
if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
