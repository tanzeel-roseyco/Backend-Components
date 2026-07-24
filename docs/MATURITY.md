# Component maturity

`components.json` is the source of truth. CI rejects missing files, duplicated
classifications, unsafe paths, and unclassified components.

## Production-ready

The component is included in the language's full Docker verification and has
deterministic tests for its repository-owned behavior. Consumers must still
review its public types, tests, limits, external adapters, and security
configuration against their application before adoption.

## Reference

The component contains useful implementation code but has not met every
production-ready requirement in this repository. Consumers must review and
adapt it for their application. Reference does not mean broken; it means the
repository does not make a release-quality claim.

## Experimental

The component is incomplete, contains placeholder behavior, or lacks enough
verification to recommend direct adoption. It remains visible so useful work is
not lost, but it must not be exposed through a stable package entry point.
