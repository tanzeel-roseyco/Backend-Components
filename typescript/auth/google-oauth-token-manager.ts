/**
 * Google OAuth2 Token Manager
 * ===========================
 *
 * Initializes a Google OAuth2 client with:
 *   - persistent token storage behind a pluggable `TokenStore` interface
 *   - automatic token refresh (listens on the client's `tokens` event and
 *     persists rotated access/refresh tokens back to the store)
 *   - proactive refresh when the access token is expired or within a
 *     configurable buffer window of expiry
 *
 * Adapted and generalized from a production codebase.
 *
 * Required environment variables:
 *   - GOOGLE_CLIENT_ID     OAuth2 client id     (never hardcode)
 *   - GOOGLE_CLIENT_SECRET OAuth2 client secret (never hardcode)
 *   - GOOGLE_OAUTH_REDIRECT_URI (optional) redirect URI for the OAuth2 client
 *
 * Key dependencies:
 *   - googleapis (google.auth.OAuth2, google.calendar)
 *
 * AIDEV-NOTE: This module owns Google token lifecycle only; it deliberately
 * does NOT know about your persistence engine (Prisma/Drizzle/SQL/etc.) — that
 * lives behind `TokenStore` so this file stays reusable and secret-free.
 * Ordering/security constraints:
 *   1. The `tokens` listener MUST be attached BEFORE any call that can trigger
 *      a refresh (refreshAccessToken / API calls), or rotated tokens are lost.
 *   2. Tokens are secrets: never log token values; only log failure reasons.
 *   3. A missing refresh_token is unrecoverable without user re-consent — fail
 *      loud with an actionable message rather than silently returning a client.
 */

import { google } from "googleapis";
import type { Auth, calendar_v3 } from "googleapis";

// AIDEV-NOTE: Original source imported an internal persistence module:
//   import { prisma } from "@/lib/prisma";
// That concrete dependency is replaced by the `TokenStore` port below so this
// component is self-contained. Provide any adapter that satisfies the interface.

/**
 * A persisted set of OAuth2 credentials for a single user/account.
 * `expiresAt` is a UNIX timestamp in SECONDS (matches the common
 * OAuth `expires_at` column convention), or null if unknown.
 */
export interface StoredToken {
  /** Opaque store-side identifier for this credential row/record. */
  id: string;
  accessToken: string | null;
  refreshToken: string | null;
  /** Expiry as UNIX epoch seconds, or null if not tracked. */
  expiresAt: number | null;
}

/**
 * Persistence port for OAuth2 tokens. Implement this with your database of
 * choice. All methods are keyed by your application's user id.
 */
export interface TokenStore {
  /**
   * Load the stored Google credentials for a user.
   * @returns the stored token, or null if the user has none linked.
   */
  getToken(userId: string): Promise<StoredToken | null>;

  /**
   * Persist a (partial) credential update for a previously loaded record.
   * Only the provided fields should be written.
   * @param recordId the `StoredToken.id` returned by {@link getToken}.
   */
  saveToken(
    recordId: string,
    update: Partial<Pick<StoredToken, "accessToken" | "refreshToken" | "expiresAt">>
  ): Promise<void>;
}

/** Configuration for {@link GoogleOAuthTokenManager}. */
export interface GoogleOAuthTokenManagerOptions {
  /** OAuth2 client id. Defaults to `process.env.GOOGLE_CLIENT_ID`. */
  clientId?: string;
  /** OAuth2 client secret. Defaults to `process.env.GOOGLE_CLIENT_SECRET`. */
  clientSecret?: string;
  /** Optional redirect URI. Defaults to `process.env.GOOGLE_OAUTH_REDIRECT_URI`. */
  redirectUri?: string;
  /**
   * Refresh the token proactively if it expires within this many milliseconds.
   * Defaults to 5 minutes.
   */
  refreshBufferMs?: number;
  /**
   * Optional sink for non-fatal errors (e.g. failed background persistence).
   * Defaults to `console.error`. Never receives raw token values.
   */
  logger?: (message: string, error?: unknown) => void;
}

const DEFAULT_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Manages Google OAuth2 clients with automatic and proactive token refresh,
 * persisting rotated tokens through an injected {@link TokenStore}.
 */
export class GoogleOAuthTokenManager {
  private readonly store: TokenStore;
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly redirectUri: string | undefined;
  private readonly refreshBufferMs: number;
  private readonly log: (message: string, error?: unknown) => void;

  /**
   * @param store  persistence adapter for reading/writing tokens.
   * @param options client credentials and refresh tuning.
   */
  constructor(store: TokenStore, options: GoogleOAuthTokenManagerOptions = {}) {
    this.store = store;
    this.clientId = options.clientId ?? process.env.GOOGLE_CLIENT_ID;
    this.clientSecret = options.clientSecret ?? process.env.GOOGLE_CLIENT_SECRET;
    this.redirectUri = options.redirectUri ?? process.env.GOOGLE_OAUTH_REDIRECT_URI;
    this.refreshBufferMs = options.refreshBufferMs ?? DEFAULT_REFRESH_BUFFER_MS;
    this.log = options.logger ?? ((m, e) => console.error(m, e));
  }

  /**
   * Build an authenticated OAuth2 client for a user, wiring automatic refresh
   * persistence and proactively refreshing if the token is near expiry.
   *
   * @param userId your application's user identifier.
   * @returns a ready-to-use {@link Auth.OAuth2Client}.
   * @throws if the user has no linked account, no refresh token, or the
   *         refresh token has been revoked/expired.
   */
  async getAuthenticatedClient(userId: string): Promise<Auth.OAuth2Client> {
    const account = await this.store.getToken(userId);

    if (!account?.accessToken) {
      throw new Error("No Google account linked. Please sign in with Google.");
    }

    if (!account.refreshToken) {
      throw new Error(
        "No refresh token stored. Please sign out and sign in again to grant offline access."
      );
    }

    const oauth2Client = new google.auth.OAuth2(
      this.clientId,
      this.clientSecret,
      this.redirectUri
    );

    oauth2Client.setCredentials({
      access_token: account.accessToken,
      refresh_token: account.refreshToken,
      expiry_date: account.expiresAt ? account.expiresAt * 1000 : undefined,
    });

    // AIDEV-NOTE: Attach the persistence listener BEFORE any refresh can fire.
    // Google emits `tokens` on automatic refresh; persist rotated values so the
    // next request reuses them. Failures here are non-fatal (the in-memory
    // client still works for this request) — log and continue.
    oauth2Client.on("tokens", (tokens) => {
      void this.persistRefreshedTokens(account.id, tokens);
    });

    // Proactively refresh if the token is expired or about to expire.
    const isExpiring =
      account.expiresAt != null &&
      account.expiresAt * 1000 < Date.now() + this.refreshBufferMs;

    if (isExpiring) {
      await this.forceRefresh(oauth2Client);
    }

    return oauth2Client;
  }

  /**
   * Convenience helper: an authenticated Google Calendar v3 client for a user.
   * Preserves the original component's primary use case.
   */
  async getCalendarClient(userId: string): Promise<calendar_v3.Calendar> {
    const auth = await this.getAuthenticatedClient(userId);
    return google.calendar({ version: "v3", auth });
  }

  /**
   * Persist rotated tokens emitted by the OAuth2 client's `tokens` event.
   * AIDEV-NOTE: Never logs token values — only that persistence failed.
   */
  private async persistRefreshedTokens(
    recordId: string,
    tokens: Auth.Credentials
  ): Promise<void> {
    try {
      const update: Partial<
        Pick<StoredToken, "accessToken" | "refreshToken" | "expiresAt">
      > = {};

      if (tokens.access_token) update.accessToken = tokens.access_token;
      if (tokens.refresh_token) update.refreshToken = tokens.refresh_token;
      if (tokens.expiry_date)
        update.expiresAt = Math.floor(tokens.expiry_date / 1000);

      if (Object.keys(update).length > 0) {
        await this.store.saveToken(recordId, update);
      }
    } catch (e) {
      this.log("Failed to persist refreshed Google tokens:", e);
    }
  }

  /**
   * Force a refresh now and re-apply the new credentials to the client.
   * Distinguishes an unrecoverable revoked/expired refresh token (requires
   * user re-consent) from a transient failure.
   */
  private async forceRefresh(client: Auth.OAuth2Client): Promise<void> {
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log("Google token refresh failed:", msg);

      // A revoked/expired refresh token cannot be recovered programmatically;
      // the user must re-authenticate to grant a fresh grant.
      if (
        msg.includes("invalid_grant") ||
        msg.includes("Token has been expired or revoked")
      ) {
        throw new Error(
          "Google refresh token expired or revoked. Please sign out and sign in again."
        );
      }
      throw new Error(`Google token refresh failed: ${msg}`);
    }
  }
}
