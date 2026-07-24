# Local scheduler

This TypeScript module is a deterministic task-placement fallback backed by injected persistence and calendar ports.

## Behavior

It calculates free gaps from work preferences and busy blocks, searches forward across days, applies task energy and preferred-window filters, and creates scheduled blocks. `rescheduleAllTasks` removes and rebuilds eligible scheduled blocks while leaving locked and in-progress work untouched. `autoScheduleTask` supports start dates, habit days, deadlines, and chunked placement.

## Inputs and dependencies

Callers supply `SchedulerDependencies`: a store, a `computeFreeSlots` function, and optionally a calendar provider and energy-colour mapper. `SchedulerConfig` controls timezone fallback, search horizon, chunking, and other limits. `SCHEDULER_DEFAULT_TIMEZONE` is the only environment setting read directly.

## Reusing it

Implement the store methods atomically, use a timezone-aware free-slot function, and confirm the store query semantics before enabling bulk rescheduling. Keep external calendar events outside deletion paths unless the host application adds explicit synchronization.

## Errors and verified limitations

External calendar failures are ignored so local scheduling can continue. Most store failures propagate, but `rescheduleAllTasks` logs and skips failures from individual tasks, so a bulk run can finish with only some tasks rescheduled. The implementation relies heavily on local `Date` operations and day strings, so daylight-saving and user-timezone behavior must be tested in the host application. Its greedy search is not an optimizer. It can return partial placement when a task cannot be fully fitted within configured chunk/search limits. There is no adjacent dedicated test file.
