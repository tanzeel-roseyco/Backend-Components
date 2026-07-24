# Hijri calendar utilities

This module converts Gregorian dates with the platform's Umm al-Qura `Intl` calendar and derives Ramadan dates, selected Islamic occasions, display strings, and an approximate moon phase. Browser callers can persist a regional day offset and optionally synchronise it against a Hijri conversion API.

No secret is required. `syncHijriOffset` accepts an API base or uses `HIJRI_SYNC_API_BASE` where available, otherwise the Aladhan public API. Browser storage holds the offset and last successful sync time. Most conversion helpers are synchronous and side-effect free.

Conversion quality depends on the host's ICU calendar data. Unsupported conversion produces an explicit zero/empty result. Network synchronisation deliberately suppresses failures so calendar display does not break, which means callers are not notified when calibration fails. Islamic dates vary by local moon sighting, and the moon-phase calculation is approximate rather than observational.

There is no dedicated test file in this repository.
