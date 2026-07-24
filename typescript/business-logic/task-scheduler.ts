/**
 * task-scheduler.ts
 *
 * Deterministic greedy task scheduler with energy constraints, deadline
 * priority, and partial (split) placement.
 *
 * Given a set of tasks and a set of free time slots for a single day, this
 * module assigns each task to concrete start/end times. It is fully
 * deterministic: the same inputs always produce the same schedule, which makes
 * it suitable as a standalone planner or as a reliable fallback behind a
 * non-deterministic (e.g. LLM-based) scheduler.
 *
 * Adapted and generalized from a production codebase. The original
 * orchestration layer (database access, calendar sync, and an optional LLM
 * scheduling pass) has been removed so this module is self-contained and
 * infrastructure-agnostic — callers supply already-computed tasks and free
 * slots and persist the returned assignments however they like.
 *
 * Required env vars: none. This module is pure and has no external I/O or
 * secrets. Any credentials (LLM keys, calendar tokens) belong to the
 * orchestration layer that feeds this scheduler, and must be read there via
 * process.env.* — never hardcoded.
 *
 * Key dependencies: none (standard library only).
 *
 * Note: This is the deterministic core of a two-tier scheduler. It must
 * stay pure and side-effect-free so it can be unit-tested and reused as a
 * fallback. Ordering constraints that MUST be preserved for correct output:
 *   1. Tasks are sorted by priority, then earliest deadline, BEFORE placement.
 *   2. Placement is greedy first-fit (whole task) then largest-gap split.
 *   3. Deep-energy tasks prefer slots inside the deep-work window.
 * Changing this ordering changes the schedule; treat it as behavioral API.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Cognitive load / context category a task requires. */
export type EnergyType = "deep" | "light" | "admin";

/**
 * Task priority buckets, highest urgency first.
 * "asap" jumps the queue ahead of everything else.
 */
export type Priority = "asap" | "high" | "medium" | "low";

/**
 * A task to be scheduled. Only fields the algorithm reads are declared here;
 * callers may carry additional metadata (title, project, etc.) on their own
 * task objects and correlate results back by `id`.
 */
export interface SchedulableTask {
  /** Stable unique identifier, echoed back on every assignment. */
  id: string;
  /** Total work required, in minutes. Never shortened by the scheduler. */
  durationMinutes: number;
  /** One of {@link Priority}; unknown values are treated as "medium". */
  priority: string;
  /** Energy category, used to honor slot energy restrictions. */
  energyType: EnergyType;
  /** Optional hard deadline; earlier deadlines are scheduled first. */
  deadline: Date | null;
}

/**
 * A contiguous window of free time on the target day.
 *
 * Note: Originally imported as `FreeSlot` from an internal `@/types`
 * module. Inlined here so the component is self-contained.
 * // import type { FreeSlot } from "@/types";
 */
export interface FreeSlot {
  /** Window start (absolute instant). */
  start: Date;
  /** Window end (absolute instant), exclusive. */
  end: Date;
  /**
   * Energy types permitted in this slot. `undefined` means all types allowed.
   * A task is only placed here if its energyType is in this list (or the list
   * is absent).
   */
  allowedEnergy?: EnergyType[];
}

/**
 * Scheduler tuning knobs. In the source these came from a per-user
 * `Preferences` record; here they are generalized into an explicit options
 * object so the algorithm has no hidden configuration.
 */
export interface SchedulerOptions {
  /** Start of the deep-work window, "HH:mm" 24-hour. */
  deepWorkStart: string;
  /** End of the deep-work window, "HH:mm" 24-hour (exclusive). */
  deepWorkEnd: string;
  /** Break inserted after each placed block, in minutes. */
  breakMinutes: number;
  /**
   * Smallest chunk a task may be split into, in minutes. Defaults to 30.
   * Chunks smaller than this are never created; leftover time is reported as
   * unscheduled instead.
   */
  minChunkMinutes?: number;
  /**
   * Maximum number of chunks a split task may occupy. Defaults to 3.
   * Note: The source code capped this at 3 even though its LLM prompt
   * mentioned 5; the deterministic path used 3, so 3 is preserved as default.
   */
  maxSplitChunks?: number;
}

/** A concrete placement of (part of) a task on the timeline. */
export interface Assignment {
  taskId: string;
  /** "HH:mm" 24-hour local wall-clock start. */
  startTime: string;
  /** "HH:mm" 24-hour local wall-clock end. */
  endTime: string;
}

/** A task (or remainder of a task) that could not be fully placed. */
export interface UnscheduledTask {
  taskId: string;
  reason: string;
}

/** Result of a scheduling run. */
export interface ScheduleResult {
  assignments: Assignment[];
  unscheduled: UnscheduledTask[];
}

// ---------------------------------------------------------------------------
// Constants & internal helpers (inlined from the original `@/lib/utils`)
// ---------------------------------------------------------------------------

const DEFAULT_MIN_CHUNK_MINUTES = 30;
const DEFAULT_MAX_SPLIT_CHUNKS = 3;

/** Priority sort weights — lower sorts earlier. */
const PRIORITY_ORDER: Record<string, number> = {
  asap: -1,
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * Parse an "HH:mm" 24-hour string into hours/minutes.
 * Note: Inlined from the original `parseTime` in `@/lib/utils`.
 * Assumes well-formed input; validate at the boundary if untrusted.
 */
function parseTime(value: string): { hours: number; minutes: number } {
  const [h, m] = value.split(":");
  return { hours: Number(h), minutes: Number(m) };
}

/** Format a Date as local "HH:mm" (zero-padded, 24-hour). */
function formatHHMM(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}

/**
 * Whether the instant at `cursorMs` falls inside the deep-work window,
 * comparing local minute-of-day against the window bounds.
 */
function isInDeepWindow(
  cursorMs: number,
  deepStartMin: number,
  deepEndMin: number
): boolean {
  const d = new Date(cursorMs);
  const minuteOfDay = d.getHours() * 60 + d.getMinutes();
  return minuteOfDay >= deepStartMin && minuteOfDay < deepEndMin;
}

// ---------------------------------------------------------------------------
// Core algorithm
// ---------------------------------------------------------------------------

/** Mutable per-slot placement state used during a scheduling run. */
interface SlotState {
  start: number;
  end: number;
  /** Next free instant in this slot (advances as tasks are placed). */
  cursor: number;
  allowedEnergy?: EnergyType[];
}

/**
 * Deterministically schedule tasks into free slots for a single day.
 *
 * Algorithm:
 *   1. Sort tasks: highest priority first, then earliest deadline.
 *   2. For each task, try first-fit: place the whole task in the earliest
 *      eligible slot that has room (deep tasks prefer deep-window slots).
 *   3. If it doesn't fit whole, split it across up to `maxSplitChunks` gaps,
 *      each at least `minChunkMinutes`, always filling the largest gap first.
 *   4. Insert a `breakMinutes` gap after every placed block.
 *   5. Report any remainder as unscheduled.
 *
 * Task durations are never shortened — a task is only "scheduled" if the full
 * duration is placed (possibly split); otherwise the placed portion is kept
 * and the remainder is reported in `unscheduled`.
 *
 * @param tasks    Tasks to place (not mutated).
 * @param freeSlots Free windows for the day (not mutated).
 * @param options  Deep-work window, break length, and split limits.
 * @returns Assignments plus any tasks that could not be fully placed.
 */
export function scheduleTasks(
  tasks: SchedulableTask[],
  freeSlots: FreeSlot[],
  options: SchedulerOptions
): ScheduleResult {
  const minChunkMinutes = options.minChunkMinutes ?? DEFAULT_MIN_CHUNK_MINUTES;
  const maxSplitChunks = options.maxSplitChunks ?? DEFAULT_MAX_SPLIT_CHUNKS;
  const minChunkMs = minChunkMinutes * 60 * 1000;
  const breakMs = options.breakMinutes * 60 * 1000;

  // Deep-work window as minute-of-day bounds.
  const deepStart = parseTime(options.deepWorkStart);
  const deepEnd = parseTime(options.deepWorkEnd);
  const deepStartMinutes = deepStart.hours * 60 + deepStart.minutes;
  const deepEndMinutes = deepEnd.hours * 60 + deepEnd.minutes;

  // Sort: high priority first, then earliest deadline. Copy to avoid mutating
  // the caller's array.
  const sorted = [...tasks].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 1;
    const pb = PRIORITY_ORDER[b.priority] ?? 1;
    if (pa !== pb) return pa - pb;
    if (a.deadline && b.deadline) {
      return a.deadline.getTime() - b.deadline.getTime();
    }
    if (a.deadline) return -1;
    if (b.deadline) return 1;
    return 0;
  });

  // Track remaining free time in each slot via an advancing cursor.
  const slotStates: SlotState[] = freeSlots.map((s) => ({
    start: s.start.getTime(),
    end: s.end.getTime(),
    cursor: s.start.getTime(),
    allowedEnergy: s.allowedEnergy, // undefined = all types allowed
  }));

  const assignments: Assignment[] = [];
  const unscheduled: UnscheduledTask[] = [];

  for (const task of sorted) {
    // Guard non-positive / NaN durations. Without this, a zero-duration task
    // would place a start==end block and a negative one would emit an inverted
    // (end < start) assignment. `!(x > 0)` also catches NaN.
    if (!(task.durationMinutes > 0)) {
      unscheduled.push({
        taskId: task.id,
        reason: "Task has no positive duration",
      });
      continue;
    }

    let remainingMs = task.durationMinutes * 60 * 1000;
    const taskEnergy = task.energyType;

    // A slot is usable if it has no energy restriction or permits this energy.
    const canUseSlot = (slot: SlotState): boolean =>
      !slot.allowedEnergy || slot.allowedEnergy.includes(taskEnergy);

    // Deep tasks prefer deep-window slots; others take slots in natural order.
    const isDeep = task.energyType === "deep";
    const getSortedSlots = (): SlotState[] => {
      const eligible = slotStates.filter(canUseSlot);
      if (!isDeep) return eligible;
      return [...eligible].sort((a, b) => {
        const aInDeep = isInDeepWindow(a.cursor, deepStartMinutes, deepEndMinutes);
        const bInDeep = isInDeepWindow(b.cursor, deepStartMinutes, deepEndMinutes);
        if (aInDeep && !bInDeep) return -1;
        if (!aInDeep && bInDeep) return 1;
        return a.cursor - b.cursor;
      });
    };

    // Pass 1: try to fit the whole task in a single slot.
    let placedFully = false;
    for (const slot of getSortedSlots()) {
      const available = slot.end - slot.cursor;
      if (available >= remainingMs) {
        const startTime = new Date(slot.cursor);
        const endTime = new Date(slot.cursor + remainingMs);

        assignments.push({
          taskId: task.id,
          startTime: formatHHMM(startTime),
          endTime: formatHHMM(endTime),
        });

        // Advance cursor past the block plus a mandatory break.
        slot.cursor = endTime.getTime() + breakMs;
        remainingMs = 0;
        placedFully = true;
        break;
      }
    }

    // Pass 2: split the task across multiple gaps, largest-gap-first.
    if (!placedFully) {
      for (
        let attempt = 0;
        attempt < maxSplitChunks && remainingMs >= minChunkMs;
        attempt++
      ) {
        // Find the largest available gap that both fits a minimum chunk and
        // allows this task's energy type.
        let bestSlot: SlotState | null = null;
        for (const slot of getSortedSlots()) {
          const available = slot.end - slot.cursor;
          if (available >= minChunkMs) {
            if (!bestSlot || available > bestSlot.end - bestSlot.cursor) {
              bestSlot = slot;
            }
          }
        }

        if (!bestSlot) break;

        const available = bestSlot.end - bestSlot.cursor;
        const chunkMs = Math.min(available, remainingMs);

        const startTime = new Date(bestSlot.cursor);
        const endTime = new Date(bestSlot.cursor + chunkMs);

        assignments.push({
          taskId: task.id,
          startTime: formatHHMM(startTime),
          endTime: formatHHMM(endTime),
        });

        bestSlot.cursor = endTime.getTime() + breakMs;
        remainingMs -= chunkMs;
      }

      // Report ANY unplaced remainder. A leftover below `minChunkMs` can't be
      // placed as a new chunk (chunks must be >= minChunkMs), but it is still
      // unscheduled work — silently dropping it would break the module's stated
      // contract that a task is only "scheduled" when its full duration fits.
      // Note: All time math is integer milliseconds (minutes * 60000), so
      // a fully-placed task lands on remainingMs === 0 exactly — no float noise,
      // so `> 0` never produces a spurious unscheduled entry.
      if (remainingMs > 0) {
        const scheduledMins =
          task.durationMinutes - Math.round(remainingMs / 60000);
        unscheduled.push({
          taskId: task.id,
          reason:
            scheduledMins > 0
              ? `Only ${scheduledMins} of ${task.durationMinutes} min fit today`
              : "No available slot fits this task",
        });
      }
    }
  }

  return { assignments, unscheduled };
}
