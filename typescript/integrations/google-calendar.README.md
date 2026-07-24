# Google Calendar helpers

This module authenticates a linked Google account, persists refreshed OAuth credentials, reads busy periods, computes free slots, and creates or deletes timed and all-day calendar events.

## Using it

Implement `GoogleTokenStore` and provide an account ID. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Use `getGoogleCalendarClient` for authentication, `getBusySlots` for calendar data, `computeFreeSlots` for local scheduling logic, and the event helpers for mutations.

Date and time strings are validated. Free-slot computation supports working windows, minimum durations, busy intervals, and availability-to-energy mappings.

## Limits

The module does not run the user-consent flow. Scheduling calculations rely on the caller providing the intended timezone and correct date boundaries. Google API retry policy and quota management are not implemented here.
