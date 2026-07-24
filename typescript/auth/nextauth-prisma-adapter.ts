/**
 * Custom NextAuth (Auth.js) Prisma Adapter with safe error serialization.
 *
 * Purpose:
 *   Wraps the official `@auth/prisma-adapter` to add defensive, log-friendly
 *   error handling around the two adapter methods most prone to silent failure
 *   (`getUserByAccount`, `getSessionAndUser`). Errors are logged with a
 *   circular-reference–safe serializer and re-thrown so callers still see the
 *   failure instead of a swallowed `null`. Also wires an OAuth provider with
 *   offline access (so a refresh token is issued) and a long-lived session.
 *
 * Required environment variables:
 *   - OAUTH_CLIENT_ID       OAuth 2.0 client id for the configured provider.
 *   - OAUTH_CLIENT_SECRET   OAuth 2.0 client secret for the configured provider.
 *   - OAUTH_SCOPES          (optional) Space-delimited scope string. Defaults
 *                           to "openid email profile" when unset.
 *   - AUTH_SECRET           NextAuth signing secret (read internally by NextAuth).
 *   - AUTH_COOKIE_SECURE    (optional) "true" to mark the session cookie Secure.
 *                           Defaults to false for local/non-TLS development.
 *   - OAUTH_ALLOW_DANGEROUS_EMAIL_LINKING
 *                           (optional) "true" to link OAuth identities to an
 *                           existing user by matching email. Defaults to false;
 *                           enable only for providers with trusted email
 *                           verification (see NOTE below).
 *
 * Key dependencies:
 *   - next-auth (Auth.js v5)
 *   - @auth/prisma-adapter
 *   - A PrismaClient instance exposing `user`, `account`, and `session` models.
 *
 * Note: Adapted and generalized from a production codebase.
 *   Security/ordering constraints:
 *   - `safeSerialize` MUST stay circular-safe: it is fed arbitrary error
 *     payloads from the OAuth layer that can contain self-referential objects.
 *   - Overridden adapter methods re-throw after logging on purpose. Do NOT
 *     convert these to silent `null` returns — a swallowed DB error here
 *     manifests downstream as a confusing "user not found" auth loop.
 *   - Session-token values are secret; only a short prefix is ever logged.
 *   - Set AUTH_COOKIE_SECURE=true in any environment served over HTTPS.
 */

import NextAuth from "next-auth";
import type { NextAuthConfig } from "next-auth";
import type { Adapter, AdapterUser } from "next-auth/adapters";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";

// Note: Internal Prisma client is project-specific and therefore not
// bundled here. Replace the import below with your own singleton client.
// Original (internal) import:
//   import { prisma } from "@/lib/prisma";
// The minimal structural interface this module actually relies on is declared
// so the file type-checks standalone. A real PrismaClient satisfies it.
import type { PrismaClient } from "@prisma/client";

/**
 * Minimal Prisma surface consumed by the custom adapter. Kept explicit so this
 * module documents exactly which models/queries it depends on.
 */
export interface AuthPrisma {
  user: {
    findUnique(args: { where: { id: string } }): Promise<UserRecord | null>;
  };
  account: {
    findUnique(args: {
      where: {
        provider_providerAccountId: {
          provider: string;
          providerAccountId: string;
        };
      };
    }): Promise<AccountRecord | null>;
  };
  session: {
    findUnique(args: {
      where: { sessionToken: string };
    }): Promise<SessionRecord | null>;
  };
}

interface UserRecord {
  id: string;
  email: string | null;
  [key: string]: unknown;
}

interface AccountRecord {
  userId: string;
  [key: string]: unknown;
}

interface SessionRecord {
  id: string;
  userId: string;
  sessionToken: string;
  expires: Date;
  [key: string]: unknown;
}

// Session lifetime, in seconds. Long-lived so re-auth is infrequent for
// long-running desktop/background clients.
const THIRTY_DAYS = 30 * 24 * 60 * 60;

// Note: Provide your project's PrismaClient singleton here.
// Cast is intentional: the concrete client is a superset of AuthPrisma.
declare const prisma: PrismaClient;
const db = prisma as unknown as AuthPrisma;

const baseAdapter = PrismaAdapter(prisma);

/**
 * JSON-serialize an arbitrary value without throwing on circular references or
 * `Error` instances.
 *
 * `Error` objects are expanded into a plain shape (name/message/stack/cause/
 * code) because `JSON.stringify` otherwise drops their enumerable-less fields.
 * Circular references are replaced with the sentinel string "[Circular]".
 *
 * @param value - Any value to serialize (typically an OAuth/adapter error).
 * @returns A pretty-printed JSON string, or a "[Unserializable: ...]" marker if
 *          serialization fails outright.
 */
function safeSerialize(value: unknown): string {
  const seen = new WeakSet<object>();

  try {
    return JSON.stringify(
      value,
      (_key, current) => {
        // Track visited objects BEFORE expanding Errors. Errors are objects
        // too, and an error whose `cause` points back to itself (or any cycle
        // routed through an Error) would otherwise recurse forever, since each
        // Error is re-expanded into a fresh object on every visit.
        if (typeof current === "object" && current !== null) {
          if (seen.has(current)) return "[Circular]";
          seen.add(current);
        }

        if (current instanceof Error) {
          // JSON.stringify drops an Error's non-enumerable fields, so expand
          // the useful ones explicitly. `cause` is passed through and re-walked
          // by this same replacer (cycle-guarded above).
          return {
            name: current.name,
            message: current.message,
            stack: current.stack,
            cause: current.cause,
            code: (current as NodeJS.ErrnoException).code,
          };
        }

        return current;
      },
      2
    );
  } catch (error) {
    return `[Unserializable: ${
      error instanceof Error ? error.message : String(error)
    }]`;
  }
}

/**
 * Custom adapter: spreads the base Prisma adapter and overrides the two lookups
 * that most benefit from explicit logging + guaranteed error propagation.
 *
 * Note: Overrides normalize `email` to "" because Auth.js's AdapterUser
 * requires a string, while the DB column is nullable.
 */
const adapter: Adapter = {
  ...baseAdapter,

  async getUserByAccount({
    provider,
    providerAccountId,
  }: {
    provider: string;
    providerAccountId: string;
  }): Promise<AdapterUser | null> {
    try {
      const account = await db.account.findUnique({
        where: {
          provider_providerAccountId: { provider, providerAccountId },
        },
      });

      if (!account) return null;

      const user = await db.user.findUnique({ where: { id: account.userId } });
      if (!user) return null;

      return { ...user, email: user.email ?? "" } as AdapterUser;
    } catch (error) {
      console.error("[AUTH ERROR] getUserByAccount failed", {
        provider,
        providerAccountId,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : String(error),
      });
      throw error; // re-throw: never mask a DB failure as a missing account
    }
  },

  async getSessionAndUser(
    sessionToken: string
  ): Promise<{ session: SessionRecord; user: AdapterUser } | null> {
    try {
      const session = await db.session.findUnique({ where: { sessionToken } });
      if (!session) return null;

      const user = await db.user.findUnique({ where: { id: session.userId } });

      if (!user) {
        // Orphaned session (user row deleted underneath it): log and treat as
        // no session so the caller forces a fresh sign-in.
        console.error("[AUTH ERROR] Orphaned session without user", {
          sessionId: session.id,
          userId: session.userId,
        });
        return null;
      }

      return {
        session,
        user: { ...user, email: user.email ?? "" } as AdapterUser,
      };
    } catch (error) {
      console.error("[AUTH ERROR] getSessionAndUser failed", {
        // Never log the full token — only a short, non-reversible prefix.
        sessionTokenPreview: `${sessionToken.slice(0, 8)}...`,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : String(error),
      });
      throw error;
    }
  },
} as Adapter;

// Default OAuth scopes. Override via OAUTH_SCOPES to request provider-specific
// resource scopes (e.g. calendar/mail) needed by your application.
const OAUTH_SCOPES = process.env.OAUTH_SCOPES ?? "openid email profile";

const authConfig: NextAuthConfig = {
  trustHost: true,
  adapter,
  providers: [
    Google({
      clientId: process.env.OAUTH_CLIENT_ID,
      clientSecret: process.env.OAUTH_CLIENT_SECRET,
      // Note: Linking an OAuth identity to an existing user by matching
      // email can enable account takeover if the provider's email verification
      // is weak. Defaults to OFF and is opt-in via env so a reusable template
      // never ships the dangerous default silently. Enable only for providers
      // whose email verification you trust.
      allowDangerousEmailAccountLinking:
        process.env.OAUTH_ALLOW_DANGEROUS_EMAIL_LINKING === "true",
      authorization: {
        params: {
          scope: OAUTH_SCOPES,
          // access_type=offline + prompt=consent ensures the provider returns a
          // refresh token so tokens can be refreshed without user interaction.
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
  ],
  session: {
    maxAge: THIRTY_DAYS,
    updateAge: 24 * 60 * 60, // slide the session at most once per 24h
  },
  cookies: {
    sessionToken: {
      name: "authjs.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        // Note: MUST be true behind HTTPS. Left env-driven so local /
        // non-TLS development still works. Never hardcode `false` in prod.
        secure: process.env.AUTH_COOKIE_SECURE === "true",
        maxAge: THIRTY_DAYS, // persist the cookie across client restarts
      },
    },
  },
  callbacks: {
    // Expose the stable user id on the session for downstream authorization.
    session({ session, user }) {
      if (session.user) session.user.id = user.id;
      return session;
    },
  },
  pages: {
    signIn: "/",
  },
  logger: {
    error(code, ...message) {
      // Expand object payloads with the circular-safe serializer; leave
      // primitives untouched so log lines stay readable.
      const expanded = message.map((m) =>
        m && typeof m === "object" ? safeSerialize(m) : m
      );
      console.error("[AUTH ERROR]", code, ...expanded);
    },
    warn(code, ...message) {
      console.warn("[AUTH WARN]", code, ...message);
    },
    debug(code, ...message) {
      console.log("[AUTH DEBUG]", code, ...message);
    },
  },
  // Note: Verbose auth debug logging. Disable (or gate on NODE_ENV) in
  // production to avoid leaking internals into logs.
  debug: process.env.NODE_ENV !== "production",
};

/**
 * Initialized NextAuth handlers and helpers.
 * - `handlers`  Route handlers (GET/POST) to mount in your framework.
 * - `auth`      Server-side session accessor.
 * - `signIn`    Programmatic sign-in helper.
 * - `signOut`   Programmatic sign-out helper.
 */
export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

export { safeSerialize, adapter };
