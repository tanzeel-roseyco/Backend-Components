# Contributing

Changes should improve a component already needed by a real application. Avoid
adding speculative abstractions or application-specific configuration.

1. Read the component README and `docs/ARCHITECTURE.md`.
2. Keep domain decisions separate from provider, framework, and persistence code.
3. Validate external inputs before side effects.
4. Add deterministic tests for the happy path and likely failures.
5. Update the adjacent README and `components.json`.
6. Run the repository's Docker checks.

Production-ready components must have explicit limits, deliberate error
propagation, injectable external dependencies, and compatibility notes.
Reference or unfinished work must not be presented as production-ready.
