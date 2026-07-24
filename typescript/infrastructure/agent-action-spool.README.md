# Durable agent action spool

This module coordinates queued agent actions across a tenant and workspace. It validates and snapshots action payloads, derives a stable request fingerprint, applies workspace and policy checks, claims leased work, and records completion or retry.

## Using it

Implement `AgentActionSpoolStore` with atomic idempotency and lease operations. Inject workspace resolution, policy evaluation, and an executor through `AgentActionSpoolDependencies`. The executor must honor the supplied idempotency key because a process can fail after the external side effect but before completion is stored.

Inputs are bounded and restricted to plain JSON values. Claimed actions are checked against their durable fingerprint and workspace before execution.

## Tests

`agent-action-spool.test.js` covers enqueueing, deduplication, policy refusal, malformed payloads, leases, retries, and conflicting durable records.

## Limits

This file supplies orchestration, not a database, queue, or action runner. Correct crash recovery depends on the store's atomicity and the executor's idempotency.
