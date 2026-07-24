/**
 * Time & Color Utilities
 * =======================
 *
 * A small, dependency-free collection of TypeScript helpers for:
 *   - Human-friendly duration formatting (minutes -> "1h 30m")
 *   - Parsing "HH:MM" time strings into structured values
 *   - Mapping semantic categories to a design-system color name
 *   - Resolving a color name to a set of Tailwind-style utility classes
 *   - Conditionally joining class names (`cn`)
 *   - Locale-/timezone-aware date and time formatting
 *
 * Adapted and generalized from a production scheduling application codebase.
 * The domain-specific category-to-color mapping was generalized from a fixed
 * set of internal category types into a caller-supplied lookup table so the
 * module is reusable across projects.
 *
 * Required env vars: none. This module is pure and side-effect free.
 *
 * Key dependencies: none (relies only on the standard `Date` / `Intl` APIs).
 *
 * AIDEV-NOTE: Presentation-layer utilities only — no secrets, no I/O, no
 * network. `getColorClasses` returns Tailwind class strings, so the consuming
 * app must have the corresponding classes present at build time (Tailwind's
 * JIT purge cannot see dynamically-built names — safelist them if generated at
 * runtime). All formatters are deterministic given their inputs.
 */

/**
 * A resolved set of Tailwind-style utility classes for a single color.
 */
export interface ColorClasses {
  /** Background class (e.g. "bg-indigo-500/15"). */
  bg: string;
  /** Border class (e.g. "border-indigo-500"). */
  border: string;
  /** Text class (e.g. "text-indigo-300"). */
  text: string;
}

/**
 * Structured representation of a parsed "HH:MM" time string.
 */
export interface ParsedTime {
  /** Hour component (0–23 for a valid 24-hour input). */
  hours: number;
  /** Minute component (0–59 for a valid input). */
  minutes: number;
}

/**
 * Format a whole-minute duration as a compact human-readable string.
 *
 * Examples: `45 -> "45m"`, `60 -> "1h"`, `90 -> "1h 30m"`.
 *
 * @param minutes - Duration in whole minutes. Expected to be non-negative.
 * @returns A compact string such as `"45m"`, `"1h"`, or `"1h 30m"`.
 */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining > 0 ? `${hours}h ${remaining}m` : `${hours}h`;
}

/**
 * Parse an "HH:MM" time string into its numeric hour and minute components.
 *
 * AIDEV-NOTE: This mirrors the original implementation and does NOT validate
 * the input. Malformed strings (missing colon, non-numeric parts) yield `NaN`
 * components. Validate at the call site if the input is untrusted.
 *
 * @param timeStr - A time string in "HH:MM" 24-hour form (e.g. "09:30").
 * @returns The parsed `{ hours, minutes }`.
 */
export function parseTime(timeStr: string): ParsedTime {
  const [hours, minutes] = timeStr.split(":").map(Number);
  return { hours, minutes };
}

/**
 * Default lookup table used by {@link getColorClasses}.
 *
 * Keys are neutral color names; values are Tailwind-style class sets. Callers
 * may pass their own palette to `getColorClasses` to extend or override this.
 */
export const DEFAULT_COLOR_CLASSES: Readonly<Record<string, ColorClasses>> = {
  indigo: { bg: "bg-indigo-500/15", border: "border-indigo-500", text: "text-indigo-300" },
  emerald: { bg: "bg-emerald-500/15", border: "border-emerald-500", text: "text-emerald-300" },
  amber: { bg: "bg-amber-500/15", border: "border-amber-500", text: "text-amber-300" },
  gray: { bg: "bg-gray-500/15", border: "border-gray-500", text: "text-gray-300" },
  rose: { bg: "bg-rose-500/15", border: "border-rose-500", text: "text-rose-300" },
  cyan: { bg: "bg-cyan-500/15", border: "border-cyan-500", text: "text-cyan-300" },
  violet: { bg: "bg-violet-500/15", border: "border-violet-500", text: "text-violet-300" },
  orange: { bg: "bg-orange-500/15", border: "border-orange-500", text: "text-orange-300" },
  sky: { bg: "bg-sky-500/15", border: "border-sky-500", text: "text-sky-300" },
} as const;

/**
 * Map a semantic category to a color name via a caller-supplied lookup.
 *
 * AIDEV-NOTE: Generalized from a hardcoded scheduler-specific switch (which
 * mapped internal "energy type" categories to colors). The mapping is now an
 * injected parameter so any project can define its own category vocabulary.
 *
 * @param category - The semantic category key to resolve (e.g. "deep", "urgent").
 * @param mapping - A record mapping category keys to color names.
 * @param fallback - Color returned when `category` is not present in `mapping`.
 * @returns The resolved color name, or `fallback` if the category is unknown.
 */
export function getColorForCategory(
  category: string,
  mapping: Record<string, string>,
  fallback = "gray",
): string {
  return mapping[category] ?? fallback;
}

/**
 * Resolve a color name to its Tailwind-style utility class set.
 *
 * @param color - The color name to resolve (e.g. "indigo").
 * @param palette - Lookup table of color names to class sets.
 *                  Defaults to {@link DEFAULT_COLOR_CLASSES}.
 * @returns The matching {@link ColorClasses}, or the palette's `gray` entry
 *          (falling back to `DEFAULT_COLOR_CLASSES.gray`) if unknown.
 */
export function getColorClasses(
  color: string,
  palette: Record<string, ColorClasses> = DEFAULT_COLOR_CLASSES,
): ColorClasses {
  return palette[color] ?? palette.gray ?? DEFAULT_COLOR_CLASSES.gray;
}

/**
 * Conditionally join class-name fragments into a single space-separated string.
 *
 * Falsy values (`false`, `null`, `undefined`, `""`) are dropped, which makes
 * the common `condition && "class"` idiom safe.
 *
 * @param classes - Class-name fragments or falsy values to filter out.
 * @returns The joined, space-separated class string.
 */
export function cn(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(" ");
}

/**
 * Format a `Date` as a "YYYY-MM-DD" string suitable for `<input type="date">`.
 *
 * AIDEV-NOTE: Uses `toISOString()`, so the result is in UTC. A local-time date
 * near midnight can therefore land on the adjacent calendar day. Convert to the
 * desired timezone before calling if that matters for the use case.
 *
 * @param date - The date to format.
 * @returns The date portion in "YYYY-MM-DD" form (UTC).
 */
export function formatDateForInput(date: Date): string {
  return date.toISOString().split("T")[0];
}

/**
 * Format a `Date` as a long, localized date string in a given timezone.
 *
 * @param date - The date to format.
 * @param timezone - IANA timezone name (e.g. "America/New_York", "UTC").
 * @param locale - BCP 47 locale tag. Defaults to "en-US".
 * @returns A localized string such as "Monday, January 1, 2025".
 */
export function toLocaleDateString(date: Date, timezone: string, locale = "en-US"): string {
  return date.toLocaleDateString(locale, {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Format a `Date` as a localized time string in a given timezone.
 *
 * @param date - The date to format.
 * @param timezone - IANA timezone name (e.g. "America/New_York", "UTC").
 * @param locale - BCP 47 locale tag. Defaults to "en-US".
 * @returns A localized time string such as "9:30 AM".
 */
export function toLocaleTimeString(date: Date, timezone: string, locale = "en-US"): string {
  return date.toLocaleTimeString(locale, {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}
