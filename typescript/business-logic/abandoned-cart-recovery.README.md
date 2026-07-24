# Abandoned cart recovery

This component processes inactive carts through a consent-aware, idempotent recovery outbox.

## Behavior

`processBatch()` lists eligible cart versions for one tenant, claims them under fenced leases, validates and freezes an immutable message snapshot, and asks the store to atomically recheck consent and suppression before creating or replaying an outbox record. It sends through an idempotent delivery port, then records sent, suppressed, or failed state.

## Inputs and outputs

Implement `AbandonedCartRecoveryStore` and `RecoverySender`. Cart prices use integer minor units and carry an explicit three-letter currency. Options control inactivity, leases, attempts, batch size, operation timeout, retry delay, and clock. Results count listed, claimed, sent, suppressed, failed, and busy carts.

## Reusing it

Back the store with transactions that enforce tenant scope, cart sequence, lease token, fence, and outbox request hash. Make the sender durable for repeated delivery keys. Run batches from a trusted scheduled worker.

## Errors and safety

The component validates identifiers, email, HTTPS checkout URLs, line counts, duplicate products, quantities, totals, dates, and returned store decisions. Operations are bounded by abortable deadlines. It does not supply email templates, unsubscribe management, cart discovery queries, or provider-specific delivery.

## Tests

`abandoned-cart-recovery.test.js` covers valid sends, suppression, replay, conflicts, malformed carts, lease loss, deadlines, retries, and store/sender failures.
