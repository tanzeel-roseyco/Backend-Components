# Component maturity

`components.json` is the source of truth. CI rejects missing files, duplicated
classifications, unsafe paths, and unclassified components.

## Production-ready

The component is included in the language's full Docker verification and has
deterministic tests for its repository-owned behavior. Consumers must still
review its public types, tests, limits, external adapters, and security
configuration against their application before adoption.

Repository grade: A.

## Reference

The component contains useful implementation code but has not met every
production-ready requirement in this repository. Consumers must review and
adapt it for their application. Reference does not mean broken; it means the
repository does not make a release-quality claim.

Repository grade: B when the component has focused tests or database-native
verification in this repository. Repository grade: C when it is useful source
without focused verification.

## Experimental

The component is incomplete, contains placeholder behavior, or lacks enough
verification to recommend direct adoption. It remains visible so useful work is
not lost, but it must not be exposed through a stable package entry point.

Repository grade: D.

## Grading system

Grades describe reuse confidence, not business value:

- A: stable package or module surface, strict verification, focused tests, and
  documented limits.
- B: useful implementation with repository tests or database verification, but
  not part of a stable package surface.
- C: useful implementation source that requires direct review, dependency
  checks, and adaptation before reuse.
- D: incomplete, placeholder, or experimental code that should not be copied
  into production without rewriting or completing it.

The grading system does not prove redistribution rights for copied code. If a
component came from another repository, maintainers still need to know that the
repository owner allows it to be published under this repository's license.
