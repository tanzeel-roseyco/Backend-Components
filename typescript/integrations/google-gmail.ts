/**
 * Gmail Message Listing & Filtering
 * =================================
 *
 * List and filter Gmail messages by query and/or label, then extract per-message
 * headers (subject / from / date), decoded plain-text body, and calendar (.ics)
 * attachments. Includes OAuth2 client bootstrap with automatic token refresh and
 * persistence, plus an optional `after:` date filter for incremental scans.
 *
 * Adapted and generalized from a production codebase.
 *
 * Required environment variables:
 *   - GOOGLE_CLIENT_ID     : OAuth2 client ID for the Google Cloud project.
 *   - GOOGLE_CLIENT_SECRET : OAuth2 client secret for the same project.
 *
 * Key dependencies:
 *   - googleapis (Google's official Node client; provides the Gmail v1 API).
 *   - An OAuth token store (see `OAuthTokenStore` below). In the original codebase
 *     this was a Prisma `account` table; here it is abstracted behind an interface
 *     so any persistence layer can be injected.
 *
 * Note: Role = read-only Gmail ingestion boundary. Ordering/security constraints:
 *   1. Credentials are set on the OAuth2 client BEFORE any API call; the `tokens`
 *      listener is attached BEFORE `refreshAccessToken()` so refreshed tokens are
 *      always persisted (googleapis emits `tokens` on both manual and lazy refresh).
 *   2. Client ID/secret come ONLY from env vars — never hardcode them.
 *   3. Body text is truncated (default 3000 chars) to bound downstream processing
 *      cost; callers relying on full bodies must raise `maxBodyChars`.
 *   4. Per-message fetch failures are logged and skipped, never thrown, so one bad
 *      message cannot abort a whole scan.
 */

import { google, type gmail_v1 } from "googleapis";

// Note: Original code imported a concrete Prisma client:
//   import { prisma } from "@/lib/prisma";
// That coupled this module to one persistence layer. It is replaced by the
// injectable `OAuthTokenStore` interface below (dependency inversion). Provide a
// thin adapter over your own DB/table to reuse this module.

/**
 * Stored OAuth token record for a single linked Google account.
 * `expiresAt` is a UNIX timestamp in SECONDS (matching common OAuth account tables).
 */
export interface OAuthAccount {
  /** Opaque primary key used when writing refreshed tokens back. */
  id: string;
  accessToken: string | null;
  refreshToken: string | null;
  /** Token expiry as UNIX epoch SECONDS, or null if unknown. */
  expiresAt: number | null;
}

/** Partial token update written back after a refresh. */
export interface OAuthTokenUpdate {
  accessToken?: string;
  refreshToken?: string;
  /** UNIX epoch SECONDS. */
  expiresAt?: number;
}

/**
 * Persistence boundary for OAuth tokens. Implement this over your own store
 * (SQL table, KV, etc.). The original implementation backed it with a Prisma
 * `account` model keyed by `{ userId, provider: "google" }`.
 */
export interface OAuthTokenStore {
  /** Return the stored Google account for a user, or null if none is linked. */
  getGoogleAccount(userId: string): Promise<OAuthAccount | null>;
  /** Persist refreshed token fields for a previously-loaded account id. */
  updateTokens(accountId: string, update: OAuthTokenUpdate): Promise<void>;
}

/** Refresh proactively when the token is within this window of expiry. */
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000; // 5 minutes

/** Default cap on extracted plain-text body length (chars). */
const DEFAULT_MAX_BODY_CHARS = 3000;

/**
 * Build an authenticated Gmail v1 client for a given user.
 *
 * Loads the user's stored Google OAuth tokens via the injected {@link OAuthTokenStore},
 * seeds an OAuth2 client, wires up automatic persistence of refreshed tokens, and
 * proactively refreshes when the access token is expired or near expiry.
 *
 * @param userId - Application user id whose linked Google account should be used.
 * @param store  - Token persistence adapter (loads/writes OAuth tokens).
 * @returns An authenticated Gmail v1 client.
 * @throws If no Google account is linked, no refresh token is stored, or the
 *         refresh token has expired / been revoked.
 */
export async function getGoogleGmailClient(
  userId: string,
  store: OAuthTokenStore
): Promise<gmail_v1.Gmail> {
  const account = await store.getGoogleAccount(userId);

  if (!account?.accessToken) {
    throw new Error("No Google account linked. Please sign in with Google.");
  }

  if (!account.refreshToken) {
    throw new Error(
      "No refresh token stored. Please sign out and sign in again to grant offline access."
    );
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    access_token: account.accessToken,
    refresh_token: account.refreshToken,
    expiry_date: account.expiresAt ? account.expiresAt * 1000 : undefined,
  });

  // Note: Attach BEFORE any refresh so googleapis' lazy + manual refreshes
  // both persist. A rotated refresh_token is only emitted once — losing it forces
  // full re-consent, so we always write whatever the event carries.
  oauth2Client.on("tokens", async (tokens) => {
    try {
      const update: OAuthTokenUpdate = {};
      if (tokens.access_token) update.accessToken = tokens.access_token;
      if (tokens.refresh_token) update.refreshToken = tokens.refresh_token;
      if (tokens.expiry_date) {
        update.expiresAt = Math.floor(tokens.expiry_date / 1000);
      }

      if (Object.keys(update).length > 0) {
        await store.updateTokens(account.id, update);
      }
    } catch (e) {
      console.error("Failed to persist refreshed Google tokens:", e);
    }
  });

  // Proactively refresh if the access token is expired or about to expire.
  const isExpired =
    account.expiresAt !== null &&
    account.expiresAt * 1000 < Date.now() + TOKEN_REFRESH_SKEW_MS;

  if (isExpired) {
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // invalid_grant means the refresh token is dead; the user must re-auth.
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

  return google.gmail({ version: "v1", auth: oauth2Client });
}

/** A single Gmail message reduced to the fields callers care about. */
export interface GmailMessageSummary {
  messageId: string;
  subject: string;
  from: string;
  /** Raw RFC 2822 `Date` header value (not parsed). */
  date: string;
  /** Decoded, concatenated `text/plain` body, truncated to `maxBodyChars`. */
  bodyText: string;
  /** Decoded contents of any `.ics` / `text/calendar` attachments. */
  icsAttachments: string[];
}

/** Options for {@link listGmailMessages}. */
export interface ListGmailMessagesOptions {
  /** Gmail search query (e.g. `"from:noreply@example.com is:unread"`). */
  query?: string;
  /**
   * Restrict to messages carrying ALL of these Gmail label ids
   * (e.g. `["INBOX", "UNREAD"]`). Combines with `query`.
   */
  labelIds?: string[];
  /** Max messages to fetch. Defaults to 20. */
  maxResults?: number;
  /** Only include messages after this date (adds a Gmail `after:` filter). */
  afterDate?: Date;
  /** Truncate extracted body text to this many chars. Defaults to 3000. */
  maxBodyChars?: number;
}

/**
 * Format a Date as Gmail's `YYYY/MM/DD` filter token (local time).
 * Note: Gmail's `after:` uses date-only granularity in the account's
 * timezone; time-of-day is intentionally dropped.
 */
function toGmailDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

/**
 * Recursively walk a MIME payload tree, accumulating decoded plain-text body
 * and any calendar (.ics) attachment contents.
 */
function extractParts(
  part: gmail_v1.Schema$MessagePart | undefined,
  acc: { bodyText: string; ics: string[] }
): void {
  if (!part) return;

  // Calendar attachment: matched by filename OR MIME type.
  const isCalendar =
    (part.filename && part.filename.endsWith(".ics")) ||
    part.mimeType === "text/calendar";
  if (isCalendar && part.body?.data) {
    acc.ics.push(Buffer.from(part.body.data, "base64").toString("utf-8"));
  }

  // Plain-text body segment.
  if (part.mimeType === "text/plain" && part.body?.data) {
    acc.bodyText += Buffer.from(part.body.data, "base64").toString("utf-8");
  }

  // Recurse into multipart children.
  if (part.parts) {
    for (const child of part.parts) extractParts(child, acc);
  }
}

/**
 * List Gmail messages matching a query and/or labels and return a reduced summary
 * (headers + plain-text body + .ics attachments) for each.
 *
 * Per-message fetch failures are logged and skipped so a single malformed message
 * does not abort the whole scan.
 *
 * @param userId  - Application user id whose Gmail should be searched.
 * @param store   - Token persistence adapter (passed through to {@link getGoogleGmailClient}).
 * @param options - Query, labels, limits, and date/body filters.
 * @returns One {@link GmailMessageSummary} per successfully fetched message.
 */
export async function listGmailMessages(
  userId: string,
  store: OAuthTokenStore,
  options: ListGmailMessagesOptions = {}
): Promise<GmailMessageSummary[]> {
  const {
    query = "",
    labelIds,
    maxResults = 20,
    afterDate,
    maxBodyChars = DEFAULT_MAX_BODY_CHARS,
  } = options;

  const gmail = await getGoogleGmailClient(userId, store);

  // Append a date filter to the query if provided.
  const fullQuery = afterDate
    ? `${query} after:${toGmailDate(afterDate)}`.trim()
    : query;

  const listRes = await gmail.users.messages.list({
    userId: "me",
    q: fullQuery || undefined,
    labelIds: labelIds && labelIds.length > 0 ? labelIds : undefined,
    maxResults,
  });

  // Empty inbox / no matches -> [] (never null); downstream may rely on .length.
  const messageIds = (listRes.data.messages ?? [])
    .map((m) => m.id)
    .filter((id): id is string => Boolean(id));
  if (messageIds.length === 0) return [];

  const results: GmailMessageSummary[] = [];

  for (const msgId of messageIds) {
    try {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: msgId,
        format: "full",
      });

      const headers = msg.data.payload?.headers ?? [];
      const headerValue = (name: string): string =>
        headers.find((h) => h.name?.toLowerCase() === name)?.value ?? "";

      const acc = { bodyText: "", ics: [] as string[] };
      extractParts(msg.data.payload ?? undefined, acc);

      results.push({
        messageId: msgId,
        subject: headerValue("subject"),
        from: headerValue("from"),
        date: headerValue("date"),
        bodyText: acc.bodyText.slice(0, maxBodyChars),
        icsAttachments: acc.ics,
      });
    } catch (err) {
      // Skip individual failures; one bad message must not abort the scan.
      console.error(`Failed to fetch Gmail message ${msgId}:`, err);
    }
  }

  return results;
}
