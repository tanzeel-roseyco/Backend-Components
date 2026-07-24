/**
 * Local Scheduler Fallback
 * ========================
 * Offline, deterministic fallback scheduler for task auto-placement.
 *
 * Given a user's working-hours preferences and a set of already-busy time
 * ranges, this module finds free gaps in a day and places tasks into them in a
 * stable priority order. It supports single-slot placement, chunked placement
 * across multiple gaps, energy-type filtering, preferred time-window filtering,
 * deadline / start-date honoring, and habit-day pinning.
 *
 * The scheduler is "offline/deterministic": it works purely from the persistence
 * store plus the user's preferences. An external calendar provider is optional —
 * if it is absent or throws, the scheduler silently ignores it and still produces
 * a schedule, which is what makes it a reliable fallback.
 *
 * Adapted and generalized from a production task-scheduling codebase.
 *
 * Required environment variables:
 *   - SCHEDULER_DEFAULT_TIMEZONE  IANA timezone used when a user has none set
 *                                 (optional; defaults to "UTC").
 *
 * Key dependencies (injected via `SchedulerDependencies` — see ports below):
 *   - store             persistence port (originally a Prisma client)
 *   - computeFreeSlots  gap-finding helper (originally "@/lib/google-calendar")
 *   - calendar          optional external busy-time provider
 *   - getColorForEnergyType  optional color mapper (default provided inline)
 *
 * Note: Role = deterministic scheduling core. Two ordering/security
 * constraints are load-bearing and MUST be preserved:
 *   1) Tasks are scheduled in strict priority order (asap>high>medium>low, then
 *      soonest deadline, then longest duration) so high-priority work claims the
 *      best slots before they fragment. Reordering this changes user-visible
 *      placement.
 *   2) "Sacred rules": never touch locked or in-progress blocks, never change a
 *      task's duration, never leave a task unscheduled (search widens up to
 *      maxSearchDays), and never delete calendar events. These invariants are
 *      enforced by the store-query contracts below; loosening a filter there can
 *      silently wipe a user's live timer or pinned block.
 *
 * The original imports are preserved (commented) next to their replacements so
 * the wiring back into an app is obvious.
 */

// --- Original internal imports (replaced by injected ports below) ------------
// import { prisma } from "@/lib/prisma";
// import { getBusySlots, computeFreeSlots } from "@/lib/google-calendar";
// import type { BusySlot } from "@/lib/google-calendar";
// import { getColorForEnergyType } from "@/lib/utils";
// import type { Availability, FreeSlot } from "@/types";
// import type { Preferences } from "@/generated/prisma/client";

// ---------------------------------------------------------------------------
// Domain types (were external @/types and generated Prisma types)
// ---------------------------------------------------------------------------

/** Energy category a task requires; slots may restrict which they allow. */
export type EnergyType = "deep" | "light" | "admin";

/** How a busy range should be interpreted. Carried through untouched. */
export type Availability = "busy" | "free" | "tentative";

/** A time range that blocks scheduling. */
export interface BusySlot {
  start: Date;
  end: Date;
  availability: Availability;
}

/** A schedulable gap in a day. */
export interface FreeSlot {
  start: Date;
  end: Date;
  durationMinutes: number;
  /** If set, only tasks whose energy type is included may use this slot. */
  allowedEnergy?: EnergyType[];
}

/** Subset of user preferences the scheduler reads. */
export interface Preferences {
  userId: string;
  /** "HH:mm", e.g. "09:00". */
  workStartTime: string | null;
  /** "HH:mm", e.g. "17:00". */
  workEndTime: string | null;
  /** IANA timezone, e.g. "UTC". */
  timezone: string | null;
  /** Buffer added after each busy range, in minutes. */
  breakMinutes: number | null;
}

/** A persisted scheduled block. Only fields the scheduler touches are typed. */
export interface ScheduledBlock {
  id: string;
  userId: string;
  taskId: string | null;
  title: string;
  startTime: Date | string;
  endTime: Date | string;
  /** Day key "YYYY-MM-DD". */
  date: string;
  color: string;
  googleEventId: string | null;
  /** Travel buffer before the block, in minutes. */
  transportBefore: number | null;
  /** Travel buffer after the block, in minutes. */
  transportAfter: number | null;
  availability: string | null;
  /** User-pinned blocks are untouchable. */
  locked: boolean;
  /** "scheduled" | "in_progress" | "completed". */
  status: string;
}

/** Payload for creating a scheduled block. */
export interface ScheduledBlockCreateInput {
  userId: string;
  taskId: string;
  title: string;
  startTime: Date;
  endTime: Date;
  date: string;
  color: string;
  googleEventId: string | null;
}

/** A task to be scheduled. Only fields the scheduler reads are typed. */
export interface Task {
  id: string;
  userId: string;
  title: string;
  durationMinutes: number;
  priority: string;
  energyType: string;
  preferredTimeWindow: string | null;
  deadline?: Date | string | null;
  hardDeadline?: boolean;
  startDate?: Date | string | null;
  completed: boolean;
  taskStatus: string;
  project?: { color: string } | null;
}

// ---------------------------------------------------------------------------
// Ports for omitted internal dependencies
// ---------------------------------------------------------------------------

/**
 * Persistence port. Each method encapsulates one of the original Prisma queries
 * with its exact filter semantics — the filters are security-critical (see the
 * "sacred rules" in the file header), so they are baked into the contract rather
 * than passed as free-form query objects.
 */
export interface SchedulerStore {
  /** Preferences for a user, or null if none exist. */
  getPreferences(userId: string): Promise<Preferences | null>;

  /** Blocks on a given day, ordered by startTime ascending. */
  getScheduledBlocksForDay(userId: string, dateKey: string): Promise<ScheduledBlock[]>;

  /**
   * Task ids that have a USER-pinned (locked) block that is NOT completed.
   * Completed blocks are auto-locked but must not freeze their task, so they are
   * excluded here.
   * (locked: true, status != "completed", taskId != null)
   */
  getLockedTaskIds(userId: string): Promise<string[]>;

  /**
   * Task ids that currently have a block in progress.
   * (status == "in_progress", taskId != null)
   */
  getRunningTaskIds(userId: string): Promise<string[]>;

  /**
   * All pending, schedulable tasks for a user, each including its project color.
   * (completed: false, taskStatus not in ["completed", "cancelled"])
   */
  getPendingTasks(userId: string): Promise<Task[]>;

  /** A single task scoped to the user, or null. */
  getTask(userId: string, taskId: string): Promise<Task | null>;

  /** Count of locked blocks for a task. */
  countLockedBlocks(userId: string, taskId: string): Promise<number>;

  /**
   * Delete a single task's blocks that are NOT locked.
   * (taskId, locked: false) — NEVER deletes locked blocks.
   */
  deleteUnlockedBlocksForTask(userId: string, taskId: string): Promise<void>;

  /**
   * Delete blocks for many tasks that are neither locked nor in progress.
   * (taskId in ids, locked: false, status != "in_progress")
   */
  deleteSchedulableBlocks(userId: string, taskIds: string[]): Promise<void>;

  /** Task ids (from the given set) that are backed by a habit generation. */
  getHabitTaskIds(taskIds: string[]): Promise<string[]>;

  /** Create and return a scheduled block. */
  createScheduledBlock(data: ScheduledBlockCreateInput): Promise<ScheduledBlock>;
}

/** Optional external calendar provider (originally Google Calendar). */
export interface CalendarProvider {
  getBusySlots(userId: string, dayStart: Date, dayEnd: Date): Promise<BusySlot[]>;
}

/**
 * Gap-finding helper (originally computeFreeSlots from "@/lib/google-calendar").
 * Given busy ranges and a work window, returns the free slots. May be sync or
 * async; the scheduler awaits it either way.
 */
export type ComputeFreeSlots = (
  busy: BusySlot[],
  workStart: string,
  workEnd: string,
  dateKey: string,
  timezone: string
) => FreeSlot[] | Promise<FreeSlot[]>;

/** Tunable scheduler configuration; every field has a sensible default. */
export interface SchedulerConfig {
  /** Default timezone when a user has none. Defaults to env or "UTC". */
  defaultTimezone?: string;
  /** Default work start "HH:mm". Defaults to "09:00". */
  defaultWorkStart?: string;
  /** Default work end "HH:mm". Defaults to "17:00". */
  defaultWorkEnd?: string;
  /** Default break buffer after busy ranges, in minutes. Defaults to 5. */
  defaultBreakMinutes?: number;
  /** Smallest chunk that will be scheduled, in minutes. Defaults to 30. */
  minChunkMinutes?: number;
  /** How many days ahead to search. Defaults to 30. */
  maxSearchDays?: number;
  /** Max chunks a single task may be split into. Defaults to 5. */
  maxChunksPerTask?: number;
  /** Latest "HH:mm" an evening (after-hours) search may begin today. */
  eveningLatestStart?: string;
  /** End "HH:mm" of the evening (after-hours) search window. */
  eveningEnd?: string;
}

/** Everything the scheduler needs, injected explicitly (no hidden globals). */
export interface SchedulerDependencies {
  store: SchedulerStore;
  computeFreeSlots: ComputeFreeSlots;
  /** Optional; omitted/failing provider is treated as "no external busy time". */
  calendar?: CalendarProvider;
  /** Optional color mapper; a neutral default is used when absent. */
  getColorForEnergyType?: (energyType: string) => string;
  config?: SchedulerConfig;
}

// ---------------------------------------------------------------------------
// Config + small inlined helpers
// ---------------------------------------------------------------------------

interface ResolvedConfig {
  defaultTimezone: string;
  defaultWorkStart: string;
  defaultWorkEnd: string;
  defaultBreakMinutes: number;
  minChunkMinutes: number;
  maxSearchDays: number;
  maxChunksPerTask: number;
  eveningLatestStart: string;
  eveningEnd: string;
}

/** Fill config defaults. Timezone default comes from env, then "UTC". */
function resolveConfig(config?: SchedulerConfig): ResolvedConfig {
  return {
    // Note: was hardcoded "America/New_York"; generalized to env-driven,
    // neutral "UTC" fallback for a public/multi-tenant context.
    defaultTimezone: config?.defaultTimezone ?? process.env.SCHEDULER_DEFAULT_TIMEZONE ?? "UTC",
    defaultWorkStart: config?.defaultWorkStart ?? "09:00",
    defaultWorkEnd: config?.defaultWorkEnd ?? "17:00",
    defaultBreakMinutes: config?.defaultBreakMinutes ?? 5,
    minChunkMinutes: config?.minChunkMinutes ?? 30,
    maxSearchDays: config?.maxSearchDays ?? 30,
    maxChunksPerTask: config?.maxChunksPerTask ?? 5,
    eveningLatestStart: config?.eveningLatestStart ?? "23:00",
    eveningEnd: config?.eveningEnd ?? "23:30",
  };
}

/** Neutral default palette (was getColorForEnergyType in "@/lib/utils"). */
const DEFAULT_ENERGY_COLORS: Record<string, string> = {
  deep: "#4f46e5",
  light: "#0ea5e9",
  admin: "#64748b",
};

function defaultColorForEnergyType(energyType: string): string {
  return DEFAULT_ENERGY_COLORS[energyType] ?? "#64748b";
}

/** Local day key "YYYY-MM-DD" from a Date. */
function dateToKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Round a Date up to the next 15-minute boundary. */
function roundUpTo15Min(date: Date): Date {
  const ms = date.getTime();
  const fifteenMin = 15 * 60 * 1000;
  return new Date(Math.ceil(ms / fifteenMin) * fifteenMin);
}

/** Keep only slots whose start hour falls in the named time window. */
function filterByTimeWindow(slots: FreeSlot[], window: string): FreeSlot[] {
  return slots.filter((s) => {
    const hour = s.start.getHours();
    switch (window) {
      case "morning": return hour < 12;
      case "afternoon": return hour >= 12 && hour < 17;
      case "evening": return hour >= 17;
      default: return true;
    }
  });
}

/** Priority weight for scheduling order: lower = scheduled first. */
const PRIORITY_WEIGHT: Record<string, number> = {
  asap: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// ---------------------------------------------------------------------------
// Core scheduling
// ---------------------------------------------------------------------------

/**
 * Gather free slots for a given day, merging local (persisted) busy blocks with
 * optional external calendar busy times, then padding each with the user's break
 * buffer.
 *
 * @param deps        Injected dependencies.
 * @param userId      Owner of the schedule.
 * @param dateKey     Day to inspect, "YYYY-MM-DD".
 * @param preferences The user's scheduling preferences.
 * @param options     Optional work-window overrides (used for evening search).
 * @returns Free slots for the day.
 */
async function getFreeSlotsForDay(
  deps: SchedulerDependencies,
  userId: string,
  dateKey: string,
  preferences: Preferences,
  options?: { overrideStart?: string; overrideEnd?: string }
): Promise<FreeSlot[]> {
  const cfg = resolveConfig(deps.config);

  const workStart = options?.overrideStart || preferences.workStartTime || cfg.defaultWorkStart;
  const workEnd = options?.overrideEnd || preferences.workEndTime || cfg.defaultWorkEnd;
  const timezone = preferences.timezone || cfg.defaultTimezone;
  const breakMinutes = preferences.breakMinutes ?? cfg.defaultBreakMinutes;

  const existingBlocks = await deps.store.getScheduledBlocksForDay(userId, dateKey);

  const localBusy: BusySlot[] = existingBlocks.map((b) => ({
    // Expand by transport buffer so travel time is also treated as busy
    start: new Date(new Date(b.startTime).getTime() - (b.transportBefore ?? 0) * 60 * 1000),
    end: new Date(new Date(b.endTime).getTime() + (b.transportAfter ?? 0) * 60 * 1000),
    availability: (b.availability || "busy") as Availability,
  }));

  let externalBusy: BusySlot[] = [];
  if (deps.calendar) {
    try {
      const dayStart = new Date(`${dateKey}T00:00:00`);
      const dayEnd = new Date(`${dateKey}T23:59:59`);
      // Coalesce to [] so a provider that resolves null/undefined (rather than
      // throwing) does not crash the spread into allBusy below.
      externalBusy = (await deps.calendar.getBusySlots(userId, dayStart, dayEnd)) ?? [];
    } catch {
      // External calendar unavailable — fall back to local-only busy times.
    }
  }

  const allBusy: BusySlot[] = [...localBusy, ...externalBusy];

  const busyWithBreaks: BusySlot[] = allBusy.map((b) => ({
    ...b,
    end: new Date(b.end.getTime() + breakMinutes * 60 * 1000),
  }));

  return deps.computeFreeSlots(busyWithBreaks, workStart, workEnd, dateKey, timezone);
}

/**
 * Find the next free slot that fits `durationMinutes`.
 *
 * Optionally starts searching from a specific date (e.g. a task's deadline day)
 * instead of today, so tasks get placed on/near their target day. If no single
 * slot fits the full duration, returns the largest available slot (at least the
 * configured minimum chunk) so callers can schedule a partial chunk.
 *
 * @param deps               Injected dependencies.
 * @param userId             Owner of the schedule.
 * @param durationMinutes    Desired duration.
 * @param preferredTimeWindow "morning" | "afternoon" | "evening" | null.
 * @param energyType         Task energy type, or null to skip energy filtering.
 * @param startFrom          Earliest date to search from (if in the future).
 * @param maxDays            How many days ahead to search (defaults to config).
 * @returns The placement, or null if nothing fits within the search window.
 */
export async function findNextFreeSlot(
  deps: SchedulerDependencies,
  userId: string,
  durationMinutes: number,
  preferredTimeWindow?: string | null,
  energyType?: string | null,
  startFrom?: Date | null,
  maxDays?: number
): Promise<{ date: string; startTime: Date; endTime: Date; isPartial?: boolean } | null> {
  const cfg = resolveConfig(deps.config);

  // Guard against corrupt/zero-length work: a non-positive duration would make
  // effectiveMinChunk 0 and emit zero-length blocks. Nothing to place — bail.
  if (durationMinutes <= 0) return null;

  const preferences = await deps.store.getPreferences(userId);
  if (!preferences) return null;

  const now = new Date();
  // Use startFrom if provided and it's in the future, otherwise use now
  const searchStart = startFrom && startFrom.getTime() > now.getTime()
    ? startFrom
    : now;

  // Pass 1: look for a slot that fits the full duration (existing behavior)
  // Pass 2: if nothing fits, find the biggest gap we can fill a chunk into
  const searchDays = maxDays ?? cfg.maxSearchDays;

  for (const allowPartial of [false, true]) {
    for (let dayOffset = 0; dayOffset < searchDays; dayOffset++) {
      const targetDate = new Date(searchStart);
      targetDate.setDate(targetDate.getDate() + dayOffset);
      const dateKey = dateToKey(targetDate);
      const isToday = dateToKey(targetDate) === dateToKey(now);

      let freeSlots = await getFreeSlotsForDay(deps, userId, dateKey, preferences);

      // For today, also look at evening slots (after work hours)
      if (isToday) {
        const workEnd = preferences.workEndTime || cfg.defaultWorkEnd;
        const nowHH = String(now.getHours()).padStart(2, "0");
        const nowMM = String(now.getMinutes()).padStart(2, "0");
        const nowHHMM = `${nowHH}:${nowMM}`;
        const eveningStart = nowHHMM > workEnd ? nowHHMM : workEnd;
        if (eveningStart < cfg.eveningLatestStart) {
          const eveningSlots = await getFreeSlotsForDay(deps, userId, dateKey, preferences, {
            overrideStart: eveningStart,
            overrideEnd: cfg.eveningEnd,
          });
          const existingKeys = new Set(freeSlots.map((s) => s.start.getTime()));
          for (const s of eveningSlots) {
            if (!existingKeys.has(s.start.getTime())) {
              freeSlots = [...freeSlots, s];
            }
          }
        }
      }

      // Filter out slots before the effective cutoff (now, or startFrom if later)
      const cutoff = searchStart.getTime() > now.getTime() ? searchStart : now;
      const isSearchStartDay = dateToKey(targetDate) === dateToKey(searchStart);
      const needsTimeFilter = isToday || (isSearchStartDay && searchStart.getTime() > now.getTime());

      const cutoffMs = cutoff.getTime();
      const clippedStart = roundUpTo15Min(cutoff); // computed once, not per-slot
      const effectiveSlots = needsTimeFilter
        ? freeSlots
            .filter((s) => s.end.getTime() > cutoffMs)
            .map((s) => {
              // Slots starting at/after the cutoff are used as-is.
              if (s.start.getTime() >= cutoffMs) return s;
              // Slots straddling the cutoff are clipped to the next 15-min boundary.
              return {
                ...s,
                start: clippedStart,
                durationMinutes: Math.round((s.end.getTime() - clippedStart.getTime()) / 60000),
              };
            })
            // Drop slots the clip shrank to zero/negative (rounded start > end).
            .filter((s) => s.durationMinutes > 0)
        : freeSlots;

      // Filter by energy type — only use slots that allow this task's energy
      const energyFilteredSlots = energyType
        ? effectiveSlots.filter((s) => !s.allowedEnergy || s.allowedEnergy.includes(energyType as EnergyType))
        : effectiveSlots;

      // Filter by preferred time window
      const preferredSlots = preferredTimeWindow
        ? filterByTimeWindow(energyFilteredSlots, preferredTimeWindow)
        : energyFilteredSlots;

      // For short tasks (< minChunk), use their actual duration as the threshold
      const effectiveMinChunk = Math.min(cfg.minChunkMinutes, durationMinutes);

      if (!allowPartial) {
        // Try preferred slots first, then all energy-eligible slots — full duration only
        for (const slots of [preferredSlots, energyFilteredSlots]) {
          for (const slot of slots) {
            if (slot.durationMinutes >= durationMinutes) {
              return {
                date: dateKey,
                startTime: slot.start,
                endTime: new Date(slot.start.getTime() + durationMinutes * 60000),
              };
            }
          }
        }
      } else {
        // Find the biggest slot we can use as a chunk
        // Prefer: preferred window first, then any energy-eligible, pick the largest
        for (const slots of [preferredSlots, energyFilteredSlots]) {
          let best: FreeSlot | null = null;
          for (const slot of slots) {
            if (slot.durationMinutes >= effectiveMinChunk) {
              if (!best || slot.durationMinutes > best.durationMinutes) {
                best = slot;
              }
            }
          }
          if (best) {
            const chunkMinutes = Math.min(best.durationMinutes, durationMinutes);
            return {
              date: dateKey,
              startTime: best.start,
              endTime: new Date(best.start.getTime() + chunkMinutes * 60000),
              isPartial: chunkMinutes < durationMinutes,
            };
          }
        }
      }
    }
  }

  return null;
}

/**
 * Reschedule ALL pending (non-completed) tasks for a user in priority order.
 * Higher priority → sooner deadline → longer duration tasks get the best slots.
 * Deletes existing (unlocked, not-in-progress) blocks for each task before
 * re-scheduling.
 *
 * SACRED RULES:
 * - Never touch locked blocks — they are untouchable
 * - Never change event duration
 * - Never leave tasks unscheduled — expand search up to maxSearchDays
 * - Past hard-deadline tasks keep their blocks — don't reschedule them
 * - Never remove events from the calendar
 *
 * @param deps   Injected dependencies.
 * @param userId Owner of the schedule.
 * @returns The first block created for each successfully scheduled task.
 */
export async function rescheduleAllTasks(
  deps: SchedulerDependencies,
  userId: string
): Promise<ScheduledBlock[]> {
  const tasks = await deps.store.getPendingTasks(userId);

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  // Tasks whose hard deadline has passed — leave their blocks untouched
  const pastDeadlineIds = new Set<string>();
  for (const t of tasks) {
    if (t.hardDeadline && t.deadline) {
      const dl = new Date(t.deadline);
      dl.setHours(0, 0, 0, 0);
      if (dl.getTime() < now.getTime()) {
        pastDeadlineIds.add(t.id);
      }
    }
  }

  // Tasks that have a USER-pinned (locked) block — never reschedule them.
  // Completed blocks are auto-locked, but they must NOT freeze their task:
  // a partially-done task (its "reschedule remaining" block) needs to stay
  // movable. Completed blocks survive the delete below (locked:false guard)
  // and are counted as busy by getFreeSlotsForDay, so excluding them here is
  // safe — it only re-enables moving the task's remaining work.
  const lockedTaskIds = new Set(await deps.store.getLockedTaskIds(userId));

  // Tasks that have a block currently in progress — never reschedule them.
  // Deleting a running block would wipe its live timer (actualStartTime) and
  // bump it back to "scheduled", which is what interrupts the timer when a new
  // task is created (createTask -> rescheduleAllTasks).
  const runningTaskIds = new Set(await deps.store.getRunningTaskIds(userId));

  const schedulableTasks = tasks.filter(
    (t) => !pastDeadlineIds.has(t.id) && !lockedTaskIds.has(t.id) && !runningTaskIds.has(t.id)
  );

  // Sort: priority (asap>high>medium>low), then deadline (soonest first, null last),
  // then duration (longest first to claim big slots before they fragment)
  schedulableTasks.sort((a, b) => {
    const pa = PRIORITY_WEIGHT[a.priority] ?? 2;
    const pb = PRIORITY_WEIGHT[b.priority] ?? 2;
    if (pa !== pb) return pa - pb;

    // Deadline: soonest first, nulls last
    const da = a.deadline ? new Date(a.deadline).getTime() : Infinity;
    const db = b.deadline ? new Date(b.deadline).getTime() : Infinity;
    if (da !== db) return da - db;

    // Longest duration first
    return b.durationMinutes - a.durationMinutes;
  });

  // Clear existing blocks for schedulable tasks — NEVER touch locked or
  // in-progress blocks (the status guard is belt-and-suspenders; running
  // tasks are already excluded from schedulableTasks above).
  const schedulableIds = schedulableTasks.map((t) => t.id);
  if (schedulableIds.length > 0) {
    await deps.store.deleteSchedulableBlocks(userId, schedulableIds);
  }

  // Identify habit tasks so they are pinned to their specific day only (maxDays=1)
  const habitTaskIds = new Set(
    schedulableIds.length > 0 ? await deps.store.getHabitTaskIds(schedulableIds) : []
  );

  // Schedule each in priority order so high-priority tasks claim the best slots
  const results: ScheduledBlock[] = [];
  for (const task of schedulableTasks) {
    try {
      const isHabit = habitTaskIds.has(task.id);
      const block = await autoScheduleTaskInternal(deps, userId, task, isHabit ? { maxDays: 1 } : undefined);
      if (block) results.push(block);
    } catch (err) {
      // Note: one task's failure must not abort the whole reschedule pass.
      console.error(`Reschedule failed for task ${task.id}:`, err);
    }
  }

  return results;
}

/**
 * Auto-schedule a single task by finding free slots and creating
 * ScheduledBlock(s). If the task is too big for any single slot, it splits into
 * chunks across multiple gaps, filling dead time intelligently.
 *
 * @param deps    Injected dependencies.
 * @param userId  Owner of the schedule.
 * @param taskId  Task to schedule.
 * @param maxDays Optional day-search cap override.
 * @returns The first created block, or null if the task was skipped/locked/absent.
 */
export async function autoScheduleTask(
  deps: SchedulerDependencies,
  userId: string,
  taskId: string,
  maxDays?: number
): Promise<ScheduledBlock | null> {
  const task = await deps.store.getTask(userId, taskId);

  if (!task || task.completed) return null;

  // If any locked block exists for this task, leave it completely alone
  const hasLockedBlock = await deps.store.countLockedBlocks(userId, task.id);
  if (hasLockedBlock > 0) return null;

  // Delete any existing scheduled blocks for this task — NEVER touch locked blocks
  await deps.store.deleteUnlockedBlocksForTask(userId, task.id);

  return autoScheduleTaskInternal(deps, userId, task, maxDays ? { maxDays } : undefined);
}

/**
 * Core scheduling logic — takes a task object directly (no DB fetch/delete).
 * Callers are responsible for having cleared the task's stale blocks first.
 */
async function autoScheduleTaskInternal(
  deps: SchedulerDependencies,
  userId: string,
  task: Task,
  options?: { maxDays?: number }
): Promise<ScheduledBlock | null> {
  const cfg = resolveConfig(deps.config);
  const colorFor = deps.getColorForEnergyType ?? defaultColorForEnergyType;

  let remainingMinutes = task.durationMinutes;
  const blocks: ScheduledBlock[] = [];

  // ASAP tasks bypass time-window preference — schedule into the very next free slot
  const effectiveTimeWindow = task.priority === "asap" ? null : task.preferredTimeWindow;

  // If the task has a deadline, start searching from the beginning of that day
  // so habit tasks (deadline = their target day) get placed on the right day
  const deadlineDate = task.deadline ? new Date(task.deadline) : null;
  let startFrom = deadlineDate
    ? new Date(deadlineDate.getFullYear(), deadlineDate.getMonth(), deadlineDate.getDate())
    : null;

  // Honor the task's earliest start date: never schedule before it.
  if (task.startDate) {
    const sd = new Date(task.startDate);
    const startFloor = new Date(sd.getFullYear(), sd.getMonth(), sd.getDate());
    if (!startFrom || startFloor.getTime() > startFrom.getTime()) {
      startFrom = startFloor;
    }
  }

  // For hard deadlines: PREFER scheduling before the deadline, but if no slot
  // is found, schedule past it anyway. NEVER leave a task unscheduled.
  let effectiveMaxDays = options?.maxDays;
  let deadlineMaxDays: number | undefined;
  if (task.hardDeadline && deadlineDate) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const deadlineDayStart = new Date(deadlineDate.getFullYear(), deadlineDate.getMonth(), deadlineDate.getDate());
    const diffMs = deadlineDayStart.getTime() - today.getTime();
    const daysUntilDeadline = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)) + 1);
    deadlineMaxDays = daysUntilDeadline; // try within deadline first
  }
  // If no explicit maxDays, search up to the configured window
  if (!effectiveMaxDays) effectiveMaxDays = cfg.maxSearchDays;

  // Keep scheduling chunks until the full task is placed (up to maxChunksPerTask).
  // SACRED RULE: Never change duration. Never leave unscheduled.
  const effectiveMinChunk = Math.min(cfg.minChunkMinutes, task.durationMinutes);

  // Try within deadline first, then expand to full search window if needed
  const searchPasses = deadlineMaxDays && deadlineMaxDays < effectiveMaxDays
    ? [deadlineMaxDays, effectiveMaxDays]
    : [effectiveMaxDays];

  for (const maxDaysPass of searchPasses) {
    if (remainingMinutes < effectiveMinChunk) break;

    for (let i = 0; i < cfg.maxChunksPerTask && remainingMinutes >= effectiveMinChunk; i++) {
      const slot = await findNextFreeSlot(
        deps,
        userId,
        remainingMinutes,
        effectiveTimeWindow,
        task.energyType,
        startFrom,
        maxDaysPass
      );

      if (!slot) break;

      const chunkMinutes = Math.round(
        (slot.endTime.getTime() - slot.startTime.getTime()) / 60000
      );

      const block = await deps.store.createScheduledBlock({
        userId,
        taskId: task.id,
        title: task.title,
        startTime: slot.startTime,
        endTime: slot.endTime,
        date: slot.date,
        color: task.project?.color || colorFor(task.energyType),
        googleEventId: null,
      });

      blocks.push(block);
      remainingMinutes -= chunkMinutes;

      if (!slot.isPartial) break;
    }

    // If placed within deadline, stop. Otherwise, next pass will search wider.
    if (blocks.length > 0) break;
  }

  return blocks.length > 0 ? blocks[0] : null;
}
