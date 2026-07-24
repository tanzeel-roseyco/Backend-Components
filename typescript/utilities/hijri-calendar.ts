/**
 * Hijri Calendar Conversion Utilities
 * -----------------------------------
 * Gregorian <-> Hijri (Islamic) calendar conversion plus derived helpers:
 * Ramadan / Laylatul Qadr detection, significant Islamic occasions, short
 * date formatting, and an astronomical moon-phase calculator.
 *
 * Conversion is done via the platform `Intl.DateTimeFormat` Umm al-Qura
 * calendar (`en-US-u-ca-islamic-umalqura`), so no bundled ephemeris tables
 * are required. A small user-controlled day offset accounts for regional
 * moon-sighting differences, and an optional network sync can auto-calibrate
 * that offset against a public Hijri-date API.
 *
 * Required / optional configuration:
 *   - No secrets are required by this module.
 *   - process.env.HIJRI_SYNC_API_BASE (optional): base URL for the Hijri
 *     conversion API used by `syncHijriOffset`. Falls back to the public
 *     Aladhan API when unset. Only read in environments where `process` and
 *     `window` both exist; browser callers may pass `apiBase` explicitly.
 *
 * Key dependencies:
 *   - Platform `Intl` with Umm al-Qura calendar support (modern browsers /
 *     Node with full ICU). Falls back to a zeroed HijriDate if unavailable.
 *   - `localStorage` (browser only) for persisting the user offset and the
 *     sync cache timestamp; all localStorage access is guarded.
 *
 * Note: Extracted and generalized from a production codebase.
 *   Role: shared, framework-free calendar utility for scheduling/UI features.
 *   Constraints: (1) Islamic days start at sunset, so "night of the Nth"
 *   logic in isLaylatulQadr intentionally inspects the NEXT Gregorian day.
 *   (2) syncHijriOffset performs network I/O and MUST fail silently, never
 *   throwing into callers, to avoid breaking render/scheduling paths.
 *   (3) All browser globals (window/localStorage/fetch) are feature-detected
 *   so the module is safe to import in SSR / server contexts.
 */

// Note: Structured Hijri date. `month` is 1-12; 0 signals a failed
// conversion (caller should treat monthName === "" / month === 0 as "unknown").
export interface HijriDate {
  day: number;
  month: number;
  monthName: string;
  year: number;
}

/** LocalStorage key for the persisted user day offset. */
const OFFSET_STORAGE_KEY = "hijri-offset";
/** LocalStorage key for the last successful sync timestamp (ms epoch). */
const SYNC_TS_STORAGE_KEY = "hijri-sync-ts";
/** Milliseconds in one day — used for offset arithmetic. */
const MS_PER_DAY = 86_400_000;
/** Default public Hijri conversion API (Gregorian -> Hijri). */
const DEFAULT_SYNC_API_BASE = "https://api.aladhan.com/v1";

/**
 * Read the user's Hijri day offset (e.g. -1 for an earlier moon sighting).
 *
 * Returns 0 in non-browser environments or when no valid offset is stored.
 *
 * @returns Integer day offset applied before conversion.
 */
export function getHijriOffset(): number {
  if (typeof window === "undefined") return 0;
  return parseInt(localStorage.getItem(OFFSET_STORAGE_KEY) || "0", 10) || 0;
}

// Note: Broad alias map — Intl month strings vary by ICU version and
// transliteration (apostrophes, diacritics). Keys are lowercased + NFKD.
const HIJRI_MONTHS: Record<string, number> = {
  muharram: 1,
  safar: 2,
  "rabi' i": 3, "rabi' al-awwal": 3, "rabiʻ i": 3,
  "rabi' ii": 4, "rabi' al-thani": 4, "rabiʻ ii": 4,
  "jumada i": 5, "jumada al-awwal": 5, "jumādā al-ūlā": 5,
  "jumada ii": 6, "jumada al-thani": 6, "jumādā al-ākhirah": 6,
  rajab: 7,
  "sha'ban": 8, shaʻban: 8, shaban: 8,
  ramadan: 9, "ramaḍān": 9,
  shawwal: 10, "shawwāl": 10,
  "dhu al-qi'dah": 11, "dhu al-qidah": 11, "dhū al-qaʿdah": 11,
  "dhu al-hijjah": 12, "dhū al-ḥijjah": 12,
};

/** Canonical display names indexed by month number (index 0 unused). */
const HIJRI_MONTH_NAMES = [
  "", "Muharram", "Safar", "Rabi' I", "Rabi' II",
  "Jumada I", "Jumada II", "Rajab", "Sha'ban",
  "Ramadan", "Shawwal", "Dhul Qi'dah", "Dhul Hijjah",
];

/**
 * Map an Intl-produced Hijri month string to its 1-12 number.
 *
 * Uses exact alias lookup first, then substring matching, then a hand-rolled
 * fallback that tolerates diacritics and transliteration variants.
 *
 * @param name Raw month string from `Intl.DateTimeFormat`.
 * @returns Month number 1-12, or 0 if unrecognized.
 */
function parseHijriMonth(name: string): number {
  const lower = name.toLowerCase().normalize("NFKD");
  if (HIJRI_MONTHS[lower]) return HIJRI_MONTHS[lower];
  for (const [key, val] of Object.entries(HIJRI_MONTHS)) {
    if (lower.includes(key) || key.includes(lower)) return val;
  }
  // Fallback: tolerate partial / diacritic-stripped month spellings.
  if (lower.includes("muharram")) return 1;
  if (lower.includes("safar")) return 2;
  if (lower.includes("rabi") && (lower.includes("i") && !lower.includes("ii"))) return 3;
  if (lower.includes("rabi") && lower.includes("ii")) return 4;
  if (lower.includes("jumada") && !lower.includes("ii")) return 5;
  if (lower.includes("jumada") && lower.includes("ii")) return 6;
  if (lower.includes("rajab")) return 7;
  if (lower.includes("sha") && lower.includes("ban")) return 8;
  if (lower.includes("ramad") || lower.includes("ramaḍ")) return 9;
  if (lower.includes("shaww")) return 10;
  if (lower.includes("qi") || lower.includes("qa")) return 11;
  if (lower.includes("hijj")) return 12;
  return 0;
}

/** Options controlling `syncHijriOffset` network behaviour. */
export interface SyncHijriOptions {
  /**
   * Base URL for the Hijri conversion API. Precedence:
   * explicit option -> process.env.HIJRI_SYNC_API_BASE -> public default.
   */
  apiBase?: string;
  /** Custom fetch implementation (defaults to global `fetch`). */
  fetchFn?: typeof fetch;
}

/**
 * Resolve the sync API base URL from options / env / default.
 *
 * @param apiBase Explicit override, if provided by the caller.
 * @returns The base URL to use for conversion requests.
 */
function resolveApiBase(apiBase?: string): string {
  if (apiBase) return apiBase;
  // Guard `process` access so this stays browser-safe.
  if (typeof process !== "undefined" && process.env?.HIJRI_SYNC_API_BASE) {
    return process.env.HIJRI_SYNC_API_BASE;
  }
  return DEFAULT_SYNC_API_BASE;
}

/**
 * Auto-calibrate the stored Hijri offset by comparing local `Intl` output
 * with an authoritative Hijri-date API. Caches the result for 12 hours in
 * localStorage so the network call happens at most twice a day.
 *
 * No-ops outside the browser. Any failure (offline, non-OK response, malformed
 * body) is swallowed so the existing offset is preserved — this must never
 * throw into callers.
 *
 * @param options Optional API base URL / fetch override.
 */
export async function syncHijriOffset(options: SyncHijriOptions = {}): Promise<void> {
  if (typeof window === "undefined") return;

  const lastSync = parseInt(localStorage.getItem(SYNC_TS_STORAGE_KEY) || "0", 10);
  const TWELVE_HOURS = 12 * 60 * 60 * 1000;
  if (Date.now() - lastSync < TWELVE_HOURS) return; // already synced recently

  const fetchFn = options.fetchFn ?? fetch;
  const apiBase = resolveApiBase(options.apiBase).replace(/\/+$/, "");

  try {
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, "0");
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const yyyy = today.getFullYear();
    const res = await fetchFn(`${apiBase}/gToH/${dd}-${mm}-${yyyy}`);
    if (!res.ok) return;
    const json = await res.json();
    const apiDay = json?.data?.hijri?.day;
    const apiMonthNum = json?.data?.hijri?.month?.number;
    if (!apiDay || !apiMonthNum) return;

    // Compare against what Intl produces with offset=0.
    const intlResult = toHijriRaw(today);
    const apiDayNum = parseInt(apiDay, 10);

    if (intlResult.month === apiMonthNum && intlResult.day === apiDayNum) {
      localStorage.setItem(OFFSET_STORAGE_KEY, "0");
    } else {
      // Probe offsets -2..+2 to find the one matching the API.
      for (let offset = -2; offset <= 2; offset++) {
        const test = toHijriRaw(new Date(today.getTime() + offset * MS_PER_DAY));
        if (test.month === apiMonthNum && test.day === apiDayNum) {
          localStorage.setItem(OFFSET_STORAGE_KEY, String(offset));
          break;
        }
      }
    }
    localStorage.setItem(SYNC_TS_STORAGE_KEY, String(Date.now()));
  } catch {
    // Silently fail — keep existing offset.
  }
}

/**
 * Convert a Gregorian date to Hijri WITHOUT applying the user offset.
 * Used internally for sync calibration where the raw baseline is needed.
 *
 * @param date Gregorian date to convert.
 * @returns The uncalibrated Hijri date (zeroed on failure).
 */
function toHijriRaw(date: Date): HijriDate {
  try {
    const formatter = new Intl.DateTimeFormat("en-US-u-ca-islamic-umalqura", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    const parts = formatter.formatToParts(date);
    const day = parseInt(parts.find((p) => p.type === "day")?.value || "0", 10);
    const monthStr = parts.find((p) => p.type === "month")?.value || "";
    const yearStr = parts.find((p) => p.type === "year")?.value || "0";
    const year = parseInt(yearStr.replace(/[^\d]/g, ""), 10);
    const month = parseHijriMonth(monthStr);
    return { day, month, monthName: HIJRI_MONTH_NAMES[month] || monthStr, year };
  } catch {
    return { day: 0, month: 0, monthName: "", year: 0 };
  }
}

/**
 * Convert a Gregorian date to its Hijri equivalent, applying the stored user
 * day offset for regional moon-sighting differences.
 *
 * @param date Gregorian date to convert.
 * @returns The Hijri date; `month === 0` / `monthName === ""` indicate failure.
 */
export function toHijri(date: Date): HijriDate {
  // Apply user offset for regional moon-sighting differences, then delegate to
  // the shared converter. Note: conversion logic lives ONLY in toHijriRaw
  // to avoid drift — do not inline the Intl formatting block here again.
  const offset = getHijriOffset();
  const adjusted = offset !== 0 ? new Date(date.getTime() + offset * MS_PER_DAY) : date;
  return toHijriRaw(adjusted);
}

/**
 * @param date Gregorian date to test.
 * @returns True if the date falls in Ramadan (Hijri month 9).
 */
export function isRamadan(date: Date): boolean {
  return toHijri(date).month === 9;
}

/**
 * Whether this date's evening is a potential Laylatul Qadr night.
 *
 * Note: The Islamic day begins at sunset, so "the night of the 21st"
 * begins on the Gregorian evening of Ramadan 20th. We therefore inspect the
 * NEXT Islamic day and check the odd nights (21, 23, 25, 27, 29).
 *
 * @param date Gregorian date whose evening is being tested.
 * @returns True if the evening begins one of the odd Laylatul Qadr nights.
 */
export function isLaylatulQadr(date: Date): boolean {
  const tomorrow = new Date(date);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const h = toHijri(tomorrow);
  if (h.month !== 9) return false;
  return [21, 23, 25, 27, 29].includes(h.day);
}

/**
 * @param date Gregorian date to test.
 * @returns The Ramadan day number (1-30) if in Ramadan, otherwise null.
 */
export function getRamadanDay(date: Date): number | null {
  const h = toHijri(date);
  return h.month === 9 ? h.day : null;
}

/** A significant Islamic occasion and its associated greeting. */
export interface IslamicOccasion {
  name: string;
  greeting: string;
}

/**
 * Resolve the significant Islamic occasion for a given date, if any.
 *
 * Covers: Ramadan, Eid al-Fitr, Eid al-Adha, Hajj season, Islamic New Year,
 * Mawlid al-Nabi, Isra & Mi'raj, Mid-Sha'ban, Ashura, and the first 10 days
 * of Dhul Hijjah.
 *
 * @param date Gregorian date to classify.
 * @returns The occasion, or null if the date is not significant.
 */
export function getIslamicOccasion(date: Date): IslamicOccasion | null {
  const h = toHijri(date);
  if (!h.month) return null;

  const { month, day } = h;

  // Ramadan (month 9) — full month.
  if (month === 9) return { name: "Ramadan", greeting: "Ramadan Mubarak!" };

  // Eid al-Fitr — Shawwal 1-3.
  if (month === 10 && day >= 1 && day <= 3) return { name: "Eid al-Fitr", greeting: "Eid Mubarak!" };

  // Dhul Hijjah 1-10 (first 10 days including Hajj + Eid al-Adha).
  if (month === 12 && day >= 1 && day <= 10) {
    if (day === 10) return { name: "Eid al-Adha", greeting: "Eid Mubarak!" };
    if (day >= 8) return { name: "Hajj", greeting: "May Allah accept their Hajj" };
    return { name: "Dhul Hijjah", greeting: "Blessed first 10 days" };
  }
  // Eid al-Adha days 11-13 (Days of Tashreeq).
  if (month === 12 && day >= 11 && day <= 13) return { name: "Eid al-Adha", greeting: "Eid Mubarak!" };

  // Islamic New Year — Muharram 1.
  if (month === 1 && day === 1) return { name: "Islamic New Year", greeting: "Happy Islamic New Year!" };

  // Ashura — Muharram 9-10.
  if (month === 1 && (day === 9 || day === 10)) return { name: "Ashura", greeting: "Day of Ashura" };

  // Mawlid al-Nabi — Rabi' I 12.
  if (month === 3 && day === 12) return { name: "Mawlid al-Nabi", greeting: "Mawlid Mubarak!" };

  // Isra & Mi'raj — Rajab 27.
  if (month === 7 && day === 27) return { name: "Isra & Mi'raj", greeting: "Blessed Night of Isra & Mi'raj" };

  // Mid-Sha'ban — Sha'ban 15.
  if (month === 8 && day === 15) return { name: "Mid-Sha'ban", greeting: "Blessed Night of Mid-Sha'ban" };

  return null;
}

/**
 * @param date Gregorian date to test.
 * @returns True if the date is any significant Islamic occasion.
 */
export function isIslamicOccasion(date: Date): boolean {
  return getIslamicOccasion(date) !== null;
}

/**
 * Format a date as a short Hijri label, e.g. "12 Ram".
 *
 * @param date Gregorian date to format.
 * @returns Short "day mon" string, or "" if conversion failed.
 */
export function formatHijriShort(date: Date): string {
  const h = toHijri(date);
  if (!h.month) return "";
  return `${h.day} ${h.monthName.substring(0, 3)}`;
}

/**
 * Format a date as "MonthName Year AH", e.g. "Ramadan 1447 AH".
 *
 * @param date Gregorian date to format.
 * @returns Month/year string, or "" if conversion failed.
 */
export function formatHijriMonthYear(date: Date): string {
  const h = toHijri(date);
  if (!h.month) return "";
  return `${h.monthName} ${h.year} AH`;
}

/** Lunar phase description for a given moment. */
export interface MoonPhaseInfo {
  /** 0-1 normalized phase (0 = new moon, 0.5 = full moon). */
  phase: number;
  name: string;
  /** Fraction of the disc illuminated, 0-1. */
  illumination: number;
}

/**
 * Compute the moon phase for a date using Meeus' "Astronomical Algorithms"
 * mean-elongation method — considerably more accurate than naive synodic
 * period counting.
 *
 * @param date Gregorian date/time to evaluate.
 * @returns Normalized phase, human-readable phase name, and illumination.
 */
export function getMoonPhase(date: Date): MoonPhaseInfo {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate() + date.getHours() / 24 + date.getMinutes() / 1440;

  let yr = y, mo = m;
  if (mo <= 2) { yr -= 1; mo += 12; }

  // Convert to Julian Day (Gregorian calendar correction via A/B terms).
  const A = Math.floor(yr / 100);
  const B = 2 - A + Math.floor(A / 4);
  const JD = Math.floor(365.25 * (yr + 4716)) + Math.floor(30.6001 * (mo + 1)) + d + B - 1524.5;

  // Julian centuries from J2000.0.
  const T = (JD - 2451545.0) / 36525.0;

  // Moon's mean elongation (degrees).
  const D = 297.8501921 + 445267.1114034 * T - 0.0018819 * T * T
    + T * T * T / 545868.0 - T * T * T * T / 113065000.0;

  // Sun's mean anomaly.
  const M = 357.5291092 + 35999.0502909 * T - 0.0001536 * T * T;

  // Moon's mean anomaly.
  const Mp = 134.9633964 + 477198.8675055 * T + 0.0087414 * T * T
    + T * T * T / 69699.0;

  const toRad = (deg: number) => deg * Math.PI / 180;
  const Drad = toRad(D);
  const Mrad = toRad(M);
  const Mprad = toRad(Mp);

  // Phase angle with periodic correction terms.
  const Dnorm = ((D % 360) + 360) % 360;
  const i = 180 - Dnorm
    - 6.289 * Math.sin(Mprad)
    + 2.100 * Math.sin(Mrad)
    - 1.274 * Math.sin(2 * Drad - Mprad)
    - 0.658 * Math.sin(2 * Drad)
    - 0.214 * Math.sin(2 * Mprad)
    - 0.110 * Math.sin(Drad);

  const illumination = Math.max(0, Math.min(1, (1 + Math.cos(toRad(i))) / 2));

  // Phase from mean elongation (0 = new, 0.5 = full).
  const normalizedPhase = Dnorm / 360;

  // Note: Cardinal phases (New/Quarter/Full) get narrow ~22° bands while
  // intermediate phases (Crescent/Gibbous) span wider ranges — matching how
  // astronomy apps present "First Quarter" as a moment rather than a wide span.
  let name: string;
  if (normalizedPhase < 0.03125 || normalizedPhase >= 0.96875) name = "New Moon";
  else if (normalizedPhase < 0.21875) name = "Waxing Crescent";
  else if (normalizedPhase < 0.28125) name = "First Quarter";
  else if (normalizedPhase < 0.46875) name = "Waxing Gibbous";
  else if (normalizedPhase < 0.53125) name = "Full Moon";
  else if (normalizedPhase < 0.71875) name = "Waning Gibbous";
  else if (normalizedPhase < 0.78125) name = "Last Quarter";
  else name = "Waning Crescent";

  return { phase: normalizedPhase, name, illumination };
}
