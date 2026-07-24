# Workflow lease

This module defines a lease contract with monotonically increasing fencing tokens and includes an in-memory implementation for tests and local development.

## Using it

Use a `WorkflowLeaseStore` to acquire, renew, and release work by key and owner. Pass the returned fencing token with every protected write so a stale worker cannot overwrite a newer worker's result.

`InMemoryWorkflowLeaseStore` validates TTLs, expires old leases, and advances the fence whenever a new lease is acquired.

## Tests

`workflow-lease.test.js` covers acquisition, renewal, release, expiry, ownership, and fencing behavior.

## Limits

The included store works in one process only. Production use requires an atomic database or distributed-store implementation using the store's clock and enforcing the fence on downstream writes.
