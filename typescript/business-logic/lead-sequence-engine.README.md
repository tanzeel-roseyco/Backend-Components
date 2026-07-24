# Lead sequence engine

This component runs bounded batches of lead-sequence steps against injected storage and delivery functions.

## Behavior

`enqueue()` validates and stores a lead with a deterministic request fingerprint. `processBatch()` lists due work, claims each step under a lease, renews the lease before delivery, calls the injected idempotent sender, and marks the step sent. Delivery or validation failures are recorded with a bounded retry time until the maximum attempt count is reached.

## Inputs and outputs

The generic lead input carries tenant, sequence, lead, email, and payload data. `LeadSequenceStore` owns enqueueing, due-step listing, claims, renewals, and state transitions. Dependencies include a payload validator, idempotent sender, and optional clock. Batch results report listed, claimed, sent, failed, and busy counts.

## Reusing it

Implement store operations with tenant scoping, atomic claims, fencing, and durable idempotency records. Make the sender return the original result for a repeated delivery key. Validate the generic payload without mutating it.

## Errors and safety

The engine bounds keys, batch sizes, attempts, leases, timeouts, and stored error text. It rejects malformed or duplicate store results and aborts timed-out operations. A lost lease is surfaced rather than hidden. It supplies orchestration only; message templates, provider adapters, consent policy, and unsubscribe handling belong elsewhere.

## Tests

`lead-sequence-engine.test.js` covers enqueueing, processing, retries, idempotency, malformed store data, lease loss, timeouts, limits, and duplicate candidates.
