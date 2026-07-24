# Quote document workflow

This component coordinates quote extraction, validation, document rendering, approval, and delivery without choosing a specific OCR, PDF, storage, or email provider.

## Behavior

`QuoteDocumentWorkflow` claims work through an injected store, extracts quote lines from an input document, validates amounts and line counts, renders artifacts, and records a pending-approval state. A separate approval path transitions an exact job version, and delivery uses a deterministic key so the delivery adapter can suppress repeats. Leases and fencing values prevent stale workers from committing.

## Inputs and outputs

Provide implementations of `QuoteExtractor`, `QuoteRenderer`, `QuoteDelivery`, and `QuoteWorkflowStore`. Documents contain an ID, filename, content type, and bytes. The store persists job snapshots, leases, approval state, artifacts, delivery results, and failure information.

## Reusing it

Wire the four ports to durable services, preserve idempotency keys at provider boundaries, and expose the extract/approve/deliver operations from authenticated application routes or jobs. Treat monetary values as minor units throughout.

## Errors and safety

The workflow bounds identifiers, document and artifact sizes, quote lines, timeouts, attempts, and errors. It verifies store snapshots and lease headroom and rejects stale approvals or changed request content. It does not implement OCR, PDF generation, user authorization, or a UI.

## Tests

`quote-document-workflow.test.js` exercises extraction, approval, delivery, replay, conflicts, validation, leases, deadlines, and failure-state behavior.
