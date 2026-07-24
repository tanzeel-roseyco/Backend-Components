/**
 * Desktop Login Token Exchange
 * ============================
 *
 * Secure token-exchange endpoint for desktop / Electron clients.
 *
 * Flow:
 *   1. A desktop app opens a browser to the web app's login page, passing a
 *      short-lived, high-entropy `code` it generated.
 *   2. After the user authenticates in the browser, the web app associates
 *      that `code` with the newly created session token.
 *   3. The desktop app polls this endpoint with the same `code`. When the
 *      exchange succeeds it receives the session token and can act as the
 *      logged-in user.
 *
 * This module validates the code pattern, enforces expiry on BOTH the
 * desktop-login record and the underlying session, and only returns a token
 * when every check passes. On any failure it returns `{ token: null }` so the
 * polling client keeps waiting instead of leaking why it failed.
 *
 * Origin: adapted and generalized from a production codebase.
 *
 * Required env vars:
 *   - (none directly) — persistence is injected via the `DesktopLoginStore`
 *     port. Your adapter (e.g. a Prisma client) reads its own connection
 *     config (DATABASE_URL, etc.) from the environment.
 *
 * Key dependencies:
 *   - next/server (NextRequest / NextResponse) for the route handler.
 *   - A `DesktopLoginStore` implementation (interface declared below). The
 *     original imported an internal Prisma client:
 *       // import { prisma } from "@/lib/prisma";
 *
 * AIDEV-NOTE: Security-critical auth boundary. Ordering constraints are
 * load-bearing and MUST be preserved:
 *   1. Validate the code PATTERN before any DB lookup — rejects malformed /
 *      injection-shaped input and avoids a query on garbage. The pattern also
 *      bounds length to prevent oversized inputs.
 *   2. Check the desktop-login record's expiry AND that a session token was
 *      attached before trusting it.
 *   3. Re-validate the SESSION independently (existence + expiry). A
 *      desktop-login row can outlive or reference a revoked/expired session;
 *      never return a session token without confirming the session is still
 *      live. This second lookup is deliberate, not redundant.
 * All failure paths collapse to `{ token: null }` — do not add distinguishing
 * error bodies/status codes that would let a caller enumerate valid codes.
 *
 * AIDEV-NOTE: This is a poll-based endpoint with no built-in rate limiting.
 * Brute-force resistance rests entirely on the code's entropy (32–128 URL-safe
 * chars). If you expose it publicly, front it with a rate limiter / WAF at the
 * edge — do not lower the CODE_PATTERN entropy floor to compensate.
 */

import { NextRequest, NextResponse } from "next/server";

// AIDEV-NOTE: Original imported an internal Prisma client. Replaced with an
// injectable port so this component is framework/ORM-agnostic and testable.
// import { prisma } from "@/lib/prisma";

/**
 * Minimal desktop-login record needed for the exchange.
 */
export interface DesktopLoginRecord {
  /** Session token linked to this login code once the browser flow completes. */
  sessionToken: string | null;
  /** Absolute expiry of the desktop-login code itself. */
  expires: Date;
}

/**
 * Minimal session record needed to confirm the session is still valid.
 */
export interface SessionRecord {
  sessionToken: string;
  /** Absolute expiry of the session. */
  expires: Date;
}

/**
 * Persistence port for the token exchange. Implement this with your ORM /
 * data layer (e.g. Prisma, Drizzle, a raw SQL adapter).
 *
 * AIDEV-NOTE: Kept intentionally narrow (only the two lookups the exchange
 * needs) so adapters stay trivial and no extra columns are exposed.
 */
export interface DesktopLoginStore {
  /** Look up a desktop-login record by its (validated) code. */
  findDesktopLoginByCode(code: string): Promise<DesktopLoginRecord | null>;
  /** Look up a session by its token. */
  findSessionByToken(sessionToken: string): Promise<SessionRecord | null>;
}

/**
 * Code format: URL-safe base64-ish, 32–128 chars. Enforces high entropy and
 * bounds length before the value ever reaches the data layer.
 */
export const CODE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

/**
 * Core exchange logic, decoupled from the HTTP layer for direct unit testing.
 *
 * @param code  Raw code supplied by the desktop client (untrusted).
 * @param store Persistence adapter implementing {@link DesktopLoginStore}.
 * @param now   Injectable clock for deterministic tests; defaults to `new Date()`.
 * @returns The live session token, or `null` if the exchange is not (yet) valid.
 */
export async function exchangeDesktopLoginCode(
  code: string,
  store: DesktopLoginStore,
  now: Date = new Date(),
): Promise<string | null> {
  // 1. Reject malformed input before touching the store.
  if (!CODE_PATTERN.test(code)) {
    return null;
  }

  // 2. The desktop-login record must exist, be unexpired, and carry a token.
  const login = await store.findDesktopLoginByCode(code);
  if (!login || login.expires <= now || !login.sessionToken) {
    return null;
  }

  // 3. Independently re-validate the underlying session (may be revoked/expired
  //    even if the login record still points at it).
  const session = await store.findSessionByToken(login.sessionToken);
  if (!session || session.expires <= now) {
    return null;
  }

  return session.sessionToken;
}

/**
 * Next.js GET route handler for the desktop-login token exchange.
 *
 * Reads `?code=` from the query string and returns `{ token }` where `token`
 * is the session token on success or `null` otherwise. Malformed codes yield
 * HTTP 400; all other non-success cases yield HTTP 200 with `{ token: null }`
 * so the polling client simply keeps waiting.
 *
 * Wire this up by binding your store, e.g.:
 *   export const GET = (req: NextRequest) => handleDesktopLoginExchange(req, myStore);
 *
 * @param req   Incoming Next.js request.
 * @param store Persistence adapter implementing {@link DesktopLoginStore}.
 */
export async function handleDesktopLoginExchange(
  req: NextRequest,
  store: DesktopLoginStore,
): Promise<NextResponse> {
  const code = req.nextUrl.searchParams.get("code") ?? "";

  // Distinguish malformed input (400) from a valid-but-not-ready code (200).
  if (!CODE_PATTERN.test(code)) {
    return NextResponse.json({ token: null }, { status: 400 });
  }

  const token = await exchangeDesktopLoginCode(code, store);
  return NextResponse.json({ token });
}
