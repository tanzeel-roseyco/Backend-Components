# Signed document processor

This component downloads completed signing documents, validates them, stores immutable copies, and commits a caller-defined state transition with idempotency controls.

## Behavior

`SignedDocumentProcessor` obtains document descriptors from an injected provider, downloads each document, validates the returned artifact, and writes it through an injected store. A deterministic operation key lets the store replay an already completed result. The store owns claiming, lease renewal, artifact persistence, completion, failure recording, and release.

## Inputs and outputs

The provider and store are explicit interfaces. The processor is constructed with a namespace, provider, store, a state-transition function, and bounded options. Processing returns the operation key, stored artifacts, resulting state, and whether the result was replayed.

## Reusing it

Implement both ports against the signing provider and durable storage used by the host application. Make claims and completion atomic in the store, retain immutable artifact checksums, and ensure the state-transition callback is deterministic for the same inputs.

## Errors and safety

Identifiers, counts, sizes, artifact content, hashes, and persisted replay results are checked. Operations use deadlines and `AbortSignal`; failures are recorded without silently replacing the original error. Provider APIs, webhook handling, signer authentication, and the final document-signing request flow are outside this component.

## Tests

`signed-document-processor.test.js` covers successful processing, replay, validation failures, lease behavior, timeouts, failure transitions, and provider/store edge cases.
