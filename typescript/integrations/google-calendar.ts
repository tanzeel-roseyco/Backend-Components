/**
 * Google Calendar Integration
 * ============================
 * OAuth2-backed Google Calendar helpers: authenticated client creation with
 * automatic token refresh, busy-slot fetching, availability-aware free-slot
 * computation, and timed/all-day event create + delete.
 *
 * Adapted and generalized from a production codebase.
 *
 * Required environment variables:
 *   - GOOGLE_CLIENT_ID      OAuth2 client id     (process.env.GOOGLE_CLIENT_ID)
 *   - GOOGLE_CLIENT_SECRET  OAuth2 client secret (process.env.GOOGLE_CLIENT_SECRET)
 *
 * Key dependencies:
 *   - googleapis (the `google` namespace: OAuth2 client + Calendar v3 client)
 *
 * AIDEV-NOTE: Role = the sole boundary between the app and the Google Calendar
 * API. Security/ordering constraints:
 *   1. OAuth credentials come ONLY from env vars — never hardcode them.
 *   2. Token persistence is delegated to an injected `GoogleTokenStore` port so
 *      no database/ORM leaks into this module. The store MUST persist refreshed
 *      tokens (the `tokens` event + proactive pre-expiry refresh) or users are
 *      forced to re-consent frequently.
 *   3. The `tokens` listener is attached BEFORE any refresh call so refreshed
 *      credentials are captured; do not reorder.
 *   4. `computeFreeSlots` is pure/deterministic (no I/O) — keep it that way so
 *      the scheduling logic stays unit-testable without network access.
 */

// AIDEV-NOTE: `googleapis` is the real runtime dependency. `calendar_v3` is the
// generated Calendar v3 typing namespace; `Auth.OAuth2Client` is the OAuth2 type.
import { google, calendar_v3, Auth } from "googleapis";

// ---------------------------------------------------------------------------
// Local domain types
// ---------------------------------------------------------------------------
// AIDEV-NOTE: Inlined from the source project's shared `@/types` module so this
// integration is self-contained. Mirror these into your own type barrel if you
// share them across the codebase.

/** Energy category a task requires; used to gate what can be scheduled where. */
export type EnergyType = "deep" | "light" | "admin" | "travel";

// ---------------------------------------------------------------------------
// Input guards
// ---------------------------------------------------------------------------
// AIDEV-NOTE: `date`/`workStartTime`/`workEndTime` are external inputs that get
// interpolated into `Date` construction and sent to Google. An invalid string
// otherwise yields an Invalid Date that silently propagates as NaN comparisons
// (empty results) or a confusing Google API error, so validate at the boundary.

/** Assert a calendar date is a real "YYYY-MM-DD" value; throws otherwise. */
function assertISODate(date: string, paramName = "date"): void {
  // Regex checks the shape; Date.parse (UTC) rejects out-of-range values like 2026-02-30.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error(`Invalid ${paramName}: expected "YYYY-MM-DD", got "${date}".`);
  }
}

/** Assert a wall-clock time is a valid 24h "HH:MM" value; throws otherwise. */
function assertHHMM(time: string, paramName: string): void {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error(`Invalid ${paramName}: expected "HH:MM", got "${time}".`);
  }
}

/**
 * How available a block of time is:
 *  - busy        → fully blocked, nothing may be scheduled
 *  - free_tight  → open but only low-energy work (light/admin/travel)
 *  - free_light  → open but only very light work (light/travel)
 *  - free        → fully transparent, does not block anything
 */
export type Availability = "busy" | "free_tight" | "free_light" | "free";

/** A schedulable gap of open time, optionally energy-restricted. */
export interface FreeSlot {
  start: Date;
  end: Date;
  durationMinutes: number;
  /** Which energy types are allowed in this slot. If undefined, all types allowed. */
  allowedEnergy?: EnergyType[];
}

/** A window of time pulled from the calendar with its computed availability. */
export interface BusySlot {
  start: Date;
  end: Date;
  summary?: string;
  availability: Availability;
}

// ---------------------------------------------------------------------------
// Token storage port (dependency inversion)
// ---------------------------------------------------------------------------
// AIDEV-NOTE: The original codebase read/wrote OAuth tokens via a Prisma
// `account` table. That persistence detail is generalized into this port so
// the integration depends on a stable interface, not a specific ORM.
// Original import (kept for provenance, replaced by the port below):
//   import { prisma } from "@/lib/prisma";
//   const account = await prisma.account.findFirst({ where: { userId, provider: "google" } });

/** A user's stored Google OAuth2 tokens. */
export interface GoogleTokenSet {
  accessToken: string | null;
  refreshToken: string | null;
  /** Absolute expiry as UNIX seconds (Google's convention), or null if unknown. */
  expiresAtSeconds: number | null;
}

/**
 * Persistence boundary for OAuth tokens. Implement this against your datastore
 * (Prisma, Drizzle, Redis, etc.). Reads must return the current token set;
 * `saveTokens` is called whenever Google issues refreshed credentials.
 */
export interface GoogleTokenStore {
  /** Load the stored token set for a user, or null if no Google account is linked. */
  loadTokens(userId: string): Promise<GoogleTokenSet | null>;
  /** Persist (partial) refreshed tokens for a user. Called on every refresh. */
  saveTokens(userId: string, tokens: Partial<GoogleTokenSet>): Promise<void>;
}

// ---------------------------------------------------------------------------
// Authenticated client creation
// ---------------------------------------------------------------------------

/** Refresh proactively when the access token is within this window of expiry. */
const REFRESH_LEEWAY_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Build an authenticated Google Calendar v3 client for a user.
 *
 * Loads the user's stored tokens via the injected {@link GoogleTokenStore},
 * wires up automatic + proactive token refresh, and persists any new tokens
 * back through the store.
 *
 * @param userId - Identifier used to look up the user's stored tokens.
 * @param store  - Port used to load and persist OAuth tokens.
 * @returns An authenticated Calendar v3 client.
 * @throws If no Google account is linked, no refresh token is stored, or the
 *         refresh token has been revoked/expired.
 */
export async function getGoogleCalendarClient(
  userId: string,
  store: GoogleTokenStore
): Promise<calendar_v3.Calendar> {
  const tokens = await store.loadTokens(userId);

  if (!tokens?.accessToken) {
    throw new Error("No Google account linked. Please sign in with Google.");
  }

  if (!tokens.refreshToken) {
    throw new Error(
      "No refresh token stored. Please sign out and sign in again to grant offline access."
    );
  }

  // OAuth2 credentials come exclusively from env vars — never hardcode them.
  const oauth2Client: Auth.OAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expiry_date: tokens.expiresAtSeconds ? tokens.expiresAtSeconds * 1000 : undefined,
  });

  // AIDEV-NOTE: Attach the refresh listener BEFORE any refresh call so
  // library-driven token rotation is always captured and persisted.
  oauth2Client.on("tokens", (rotated) => {
    const next: Partial<GoogleTokenSet> = {};
    if (rotated.access_token) next.accessToken = rotated.access_token;
    if (rotated.refresh_token) next.refreshToken = rotated.refresh_token;
    if (rotated.expiry_date) next.expiresAtSeconds = Math.floor(rotated.expiry_date / 1000);

    if (Object.keys(next).length > 0) {
      // Fire-and-forget persistence; a failed save must not crash the request,
      // but it must be surfaced in logs for observability.
      void store.saveTokens(userId, next).catch((e) => {
        console.error("Failed to persist refreshed Google tokens:", e);
      });
    }
  });

  // Proactively refresh if the access token is expired or about to expire.
  const isExpiring =
    tokens.expiresAtSeconds !== null &&
    tokens.expiresAtSeconds * 1000 < Date.now() + REFRESH_LEEWAY_MS;

  if (isExpiring) {
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Google token refresh failed:", msg);

      // A revoked/expired refresh token is unrecoverable — the user must re-consent.
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

  return google.calendar({ version: "v3", auth: oauth2Client });
}

// ---------------------------------------------------------------------------
// Availability model
// ---------------------------------------------------------------------------

/**
 * Map an availability level to the set of energy types allowed during that time.
 * - busy       → nothing allowed (empty array)
 * - free_tight → light + admin + travel (no deep work)
 * - free_light → light + travel only
 * - free       → all types
 *
 * @param availability - The availability level of a time block.
 * @returns The energy types that may be scheduled in that block.
 */
export function availabilityToAllowedEnergy(availability: Availability): EnergyType[] {
  switch (availability) {
    case "busy":
      return [];
    case "free_tight":
      return ["light", "admin", "travel"];
    case "free_light":
      return ["light", "travel"];
    case "free":
      return ["deep", "light", "admin", "travel"];
  }
}

// ---------------------------------------------------------------------------
// Reading the calendar
// ---------------------------------------------------------------------------

/**
 * Fetch timed events from the user's primary calendar within a window and
 * classify each as busy or free (via Google's `transparency` flag).
 *
 * All-day and cancelled events are skipped — only events with concrete
 * start/end `dateTime` values are returned.
 *
 * @param userId - Identifier used to build the authenticated client.
 * @param store  - Token persistence port.
 * @param start  - Window start (inclusive).
 * @param end    - Window end (exclusive).
 * @returns The busy/free slots occupying the window, sorted by start time.
 */
export async function getBusySlots(
  userId: string,
  store: GoogleTokenStore,
  start: Date,
  end: Date
): Promise<BusySlot[]> {
  const calendar = await getGoogleCalendarClient(userId, store);

  const response = await calendar.events.list({
    calendarId: "primary",
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  const events = response.data.items ?? [];

  return events
    .filter((event) => {
      // Skip all-day events (no dateTime) and cancelled events.
      if (!event.start?.dateTime || !event.end?.dateTime) return false;
      if (event.status === "cancelled") return false;
      return true;
    })
    .map((event) => {
      // Google Calendar: transparency "transparent" = free, "opaque" (default) = busy.
      const availability: Availability =
        event.transparency === "transparent" ? "free" : "busy";

      return {
        // Non-null assertions are safe here: the filter above guarantees dateTime.
        start: new Date(event.start!.dateTime!),
        end: new Date(event.end!.dateTime!),
        summary: event.summary ?? undefined,
        availability,
      };
    });
}

// ---------------------------------------------------------------------------
// Free-slot computation (pure)
// ---------------------------------------------------------------------------

/** Minimum length (minutes) for a gap to be worth surfacing as a free slot. */
const MIN_SLOT_MINUTES = 5;

/**
 * Compute schedulable free slots for a single day from a set of busy slots,
 * honoring energy restrictions. Pure and deterministic — no I/O.
 *
 * Algorithm:
 *  1. "busy" events fully block time (gaps between them become raw free slots).
 *  2. "free_tight" / "free_light" events keep the time available but attach
 *     an `allowedEnergy` restriction to the overlapping portion.
 *  3. "free" events are transparent and ignored entirely.
 *
 * Unrestricted slots have no `allowedEnergy`; restricted slots list exactly
 * which energy types may be scheduled there.
 *
 * @param busySlots     - Slots from {@link getBusySlots} for the day.
 * @param workStartTime - Local work-day start, "HH:MM".
 * @param workEndTime   - Local work-day end, "HH:MM".
 * @param date          - The day being scheduled, "YYYY-MM-DD".
 * @param _timezone     - Reserved for future tz-aware boundary math (unused).
 * @returns The free slots for the day, in chronological order.
 */
export function computeFreeSlots(
  busySlots: BusySlot[],
  workStartTime: string,
  workEndTime: string,
  date: string,
  _timezone: string
): FreeSlot[] {
  assertISODate(date);
  assertHHMM(workStartTime, "workStartTime");
  assertHHMM(workEndTime, "workEndTime");

  const dayStart = new Date(`${date}T${workStartTime}:00`);
  const dayEnd = new Date(`${date}T${workEndTime}:00`);

  // Separate blocking (busy) from restricting (free_tight/free_light) events.
  // Fully "free" events are transparent and dropped.
  const blockingSlots = busySlots
    .filter((s) => s.availability === "busy")
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const restrictedSlots = busySlots
    .filter((s) => s.availability === "free_tight" || s.availability === "free_light")
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  // Step 1: Compute raw gaps between blocking events, clamped to work hours.
  const rawFreeSlots: { start: number; end: number }[] = [];
  let cursor = dayStart.getTime();

  for (const busy of blockingSlots) {
    const busyStart = busy.start.getTime();
    const busyEnd = busy.end.getTime();

    // Skip events entirely outside work hours.
    if (busyEnd <= dayStart.getTime() || busyStart >= dayEnd.getTime()) continue;

    const effectiveStart = Math.max(busyStart, dayStart.getTime());
    const effectiveEnd = Math.min(busyEnd, dayEnd.getTime());

    if (cursor < effectiveStart) {
      rawFreeSlots.push({ start: cursor, end: effectiveStart });
    }

    cursor = Math.max(cursor, effectiveEnd);
  }

  // Final gap after the last blocking event.
  if (cursor < dayEnd.getTime()) {
    rawFreeSlots.push({ start: cursor, end: dayEnd.getTime() });
  }

  // Step 2: Split raw slots around any overlapping restricted events.
  const result: FreeSlot[] = [];

  for (const free of rawFreeSlots) {
    const overlapping = restrictedSlots.filter((r) => {
      const rStart = Math.max(r.start.getTime(), dayStart.getTime());
      const rEnd = Math.min(r.end.getTime(), dayEnd.getTime());
      return rStart < free.end && rEnd > free.start;
    });

    if (overlapping.length === 0) {
      // Fully open slot — no restrictions.
      pushSlot(result, free.start, free.end);
      continue;
    }

    // Walk the slot, emitting unrestricted gaps and restricted sub-slots.
    let splitCursor = free.start;

    for (const r of overlapping) {
      const rStart = Math.max(r.start.getTime(), free.start);
      const rEnd = Math.min(r.end.getTime(), free.end);

      // Unrestricted gap before this restricted event.
      if (splitCursor < rStart) {
        pushSlot(result, splitCursor, rStart);
      }

      // The restricted portion, carrying its energy allowance.
      const actualStart = Math.max(splitCursor, rStart);
      pushSlot(result, actualStart, rEnd, availabilityToAllowedEnergy(r.availability));

      splitCursor = Math.max(splitCursor, rEnd);
    }

    // Unrestricted gap after the last restricted event.
    if (splitCursor < free.end) {
      pushSlot(result, splitCursor, free.end);
    }
  }

  return result;
}

/**
 * Append a free slot to `out` if it meets the minimum duration.
 * AIDEV-NOTE: Extracted to remove the four duplicated push blocks in the
 * original `computeFreeSlots`; keeps the min-duration rule in one place.
 */
function pushSlot(
  out: FreeSlot[],
  startMs: number,
  endMs: number,
  allowedEnergy?: EnergyType[]
): void {
  const mins = (endMs - startMs) / 60000;
  if (mins < MIN_SLOT_MINUTES) return;

  const slot: FreeSlot = {
    start: new Date(startMs),
    end: new Date(endMs),
    durationMinutes: Math.floor(mins),
  };
  if (allowedEnergy) slot.allowedEnergy = allowedEnergy;
  out.push(slot);
}

// ---------------------------------------------------------------------------
// Writing to the calendar
// ---------------------------------------------------------------------------

/**
 * Create a timed event on the user's primary calendar.
 *
 * @param userId  - Identifier used to build the authenticated client.
 * @param store   - Token persistence port.
 * @param summary - Event title.
 * @param start   - Event start.
 * @param end     - Event end.
 * @param colorId - Optional Google Calendar color id (defaults to "9").
 * @returns The created event's id.
 */
export async function createCalendarEvent(
  userId: string,
  store: GoogleTokenStore,
  summary: string,
  start: Date,
  end: Date,
  colorId = "9"
): Promise<string> {
  const calendar = await getGoogleCalendarClient(userId, store);

  const response = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      colorId,
    },
  });

  return response.data.id!;
}

/**
 * Create an all-day event on the user's primary calendar.
 *
 * @param userId  - Identifier used to build the authenticated client.
 * @param store   - Token persistence port.
 * @param summary - Event title.
 * @param date    - The all-day date, "YYYY-MM-DD".
 * @returns The created event's id.
 */
export async function createAllDayCalendarEvent(
  userId: string,
  store: GoogleTokenStore,
  summary: string,
  date: string
): Promise<string> {
  assertISODate(date);
  const calendar = await getGoogleCalendarClient(userId, store);

  // Google all-day events use an exclusive end date (the following day).
  // AIDEV-NOTE: Compute the +1-day end entirely in UTC. Parsing local midnight
  // and then calling toISOString() shifts the date across the UTC boundary for
  // east-of-UTC servers (local midnight = previous calendar day in UTC), which
  // produced an off-by-one end date. Staying in UTC end-to-end keeps the
  // calendar-date arithmetic stable regardless of the server's timezone.
  const endDate = new Date(`${date}T00:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() + 1);
  const endDateStr = endDate.toISOString().split("T")[0];

  const response = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary,
      start: { date },
      end: { date: endDateStr },
    },
  });

  return response.data.id!;
}

/**
 * Delete an event from the user's primary calendar. A 404 (already deleted) is
 * treated as success; all other errors propagate.
 *
 * @param userId  - Identifier used to build the authenticated client.
 * @param store   - Token persistence port.
 * @param eventId - The event id to delete.
 */
export async function deleteCalendarEvent(
  userId: string,
  store: GoogleTokenStore,
  eventId: string
): Promise<void> {
  const calendar = await getGoogleCalendarClient(userId, store);

  try {
    await calendar.events.delete({ calendarId: "primary", eventId });
  } catch (error: unknown) {
    // Ignore 404 — the event is already gone, which is the desired end state.
    const status = (error as { code?: number })?.code;
    if (status !== 404) throw error;
  }
}
