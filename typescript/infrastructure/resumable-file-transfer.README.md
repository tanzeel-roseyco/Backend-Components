# Resumable file transfer

This component copies a large object in chunks while recording progress under a renewable, fenced lease. It supports restarting an interrupted upload and reconciling stranded transfers.

## Using it

Implement `TransferStore`, `SourceObjectStore`, and `DestinationObjectStore`, then construct the transfer service with limits for chunk size, lease duration, attempts, and total runtime. Records are tenant-scoped and include source metadata, a SHA-256 checksum, progress offset, destination session, and fencing identity.

The implementation checks source and destination size and checksum, renews the lease during work, and refuses stale or mismatched records. Store writes must enforce the lease token and fence atomically.

## Tests

`resumable-file-transfer.test.js` exercises successful and resumed copies, deduplication, lease loss, timeouts, checksum errors, and reconciliation.

## Limits

No concrete object store or database adapter is included. Cleanup of abandoned provider upload sessions is provider-specific and must be added by the consumer.
