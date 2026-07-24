# AI cost guard

This component reserves an estimated AI cost before a provider call, validates reported token usage afterward, and stores a replayable result with the actual charge.

## Using it

Represent model prices as nano-US dollars per token, implement `CostReservationStore`, and call `executeWithCostGuard` with tenant, actor, endpoint, operation, semantic request digest, budget, estimate, and provider callback. `calculateModelCostNanoUsd` performs integer cost calculation with `bigint`.

The store can return an earlier completed result, refuse a conflicting operation key, or reject a reservation that exceeds budget. Failed or unverifiable provider calls are quarantined for later billing reconciliation.

## Tests

`ai-cost-guard.test.js` covers cost calculation, replay, conflicts, budget rejection, invalid usage, provider failure, and overage handling.

## Limits

The guard is only as strong as the atomic reservation store and the provider's usage report. It does not fetch prices or reconcile quarantined calls by itself.
