# Engineering standards

## Scope and maturity

Every implementation is classified in `components.json`.

- **Production-ready:** enforced by the language build, lint, tests, package
  checks, and CI. Its public contract is documented and compatibility matters.
- **Reference:** useful working source that requires application-specific review.
- **Experimental:** incomplete or insufficiently verified code that must not be
  presented as production-ready.

Classification changes require implementation evidence, tests, documentation,
and a successful full verification run.

## Architecture

Domain and workflow code must not depend on web frameworks, databases, or
provider SDKs. Those dependencies stay behind small injected interfaces.
Adapters own serialization, authentication, network limits, and provider error
translation. Applications own composition, secrets, storage implementations,
and deployment.

Modules have one primary responsibility. Add an abstraction only when it
protects a real boundary or removes current duplication.

## Languages

- TypeScript targets supported Node LTS releases, uses `strict`, and publishes
  declarations and explicit package exports.
- Python supports the versions declared in `pyproject.toml`, is fully typed at
  public boundaries, and passes its configured type and lint checks.
- Go uses the version declared in `go.mod`, passes `go vet`, and is race-tested.
- PostgreSQL examples target the documented PostgreSQL/Supabase version and
  include forward, behavior, and repeatable rollback checks.

## Inputs, state, and errors

Validate untrusted network, webhook, environment, file, and persistence data
before business side effects. Set explicit size, count, time, and retry bounds.
Stateful workflows must document their atomicity, idempotency, replay, and
concurrency expectations.

Never swallow failures. Provider-facing detail must be bounded and must not
expose secrets. Public errors should be stable enough for consumers to classify
without parsing prose when a component has more than one actionable failure.

## Security

No credentials, customer data, unsafe test fixtures, or secret-shaped examples
belong in the repository. Use constant-time comparisons for authentication
material. Network components must defend against unsafe redirects, unbounded
responses, and ignored cancellation where applicable. Authorization and tenant
isolation fail closed.

## Observability

Reusable components do not choose a logging or telemetry vendor. Components
with meaningful operations accept optional structured hooks or return enough
stable context for the adopting application to record duration, outcome,
attempt, tenant, and correlation identifiers. Secrets and payload bodies are
never emitted by default.

## Tests

Tests are deterministic and behavior-oriented. Production-ready components
cover the happy path, the two most likely failures, documented limits, and
security or concurrency behavior relevant to the component. External systems
are exercised through controlled adapters; internal implementation details are
not mocked.

All supported checks run in Docker. CI is the source of truth before release.

## Compatibility and releases

Use semantic versioning for published packages and repository release tags.
Breaking public contract changes require a major version. Additions are minor;
compatible corrections are patches. Every release records its production-ready
component set and verification status.

## Performance

External work must be bounded. Avoid repeated remote calls in loops where a
batch operation exists. A component with a known algorithmic or memory ceiling
documents that ceiling beside its adoption guidance.
