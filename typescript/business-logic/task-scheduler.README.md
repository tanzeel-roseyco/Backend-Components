# Deterministic task scheduler

This pure function places tasks into free time slots for one day. It is intended as a predictable fallback when calendar access or a more elaborate scheduler is unavailable.

## Behavior

Tasks are copied and sorted by priority, then deadline. The scheduler first tries to fit a whole task into an eligible slot. If that fails, it can split the task across the largest remaining gaps, subject to minimum chunk and maximum chunk settings. Deep-work tasks prefer the configured deep-work window, energy restrictions are honoured, and a break is added after each placement.

## Inputs and outputs

Call `scheduleTasks(tasks, freeSlots, options)`. Tasks need an ID, duration in minutes, priority, energy type, and optional deadline. Slots contain absolute start and end dates and may restrict energy types. Options define the deep-work window, break length, and optional split limits. The result contains `HH:mm` assignments and any unscheduled remainder.

## Reusing it

Validate external data before calling it, pass slots for a single local day, and preserve task IDs so results can be joined to application records. Persist or sync assignments outside this module.

## Verified limitations

The function has no database or calendar I/O. Time strings are assumed to be valid, times are formatted in the runtime's local timezone, and overnight deep-work windows are not represented. Placement is greedy rather than globally optimal. This file has no adjacent dedicated test file.
