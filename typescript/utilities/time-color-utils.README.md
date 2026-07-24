# Time and colour utilities

This file contains small presentation helpers for schedules and date-based interfaces. It formats minute durations, parses `HH:MM` strings, maps categories to colour names and Tailwind class sets, joins conditional class names, and formats dates or times for a chosen locale and time zone.

There is no configuration, network access, or stored state. Callers pass dates, category maps, and optional locale values directly. The functions return strings or simple objects and do not mutate their inputs.

`parseTime` splits the supplied value and converts both parts to numbers; it does not enforce a valid 24-hour range. Tailwind projects must ensure that the returned static class names are included in their build. Invalid dates, time zones, or locales follow the behaviour of the platform `Date` and `Intl` APIs.

Reuse the file when an application needs these exact formatting conventions. It has no dedicated test file in this repository.
