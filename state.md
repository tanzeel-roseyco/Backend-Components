# Project state

The repository is being normalized into a release-quality reusable component
library. The stable TypeScript surface and Go package contain the components
classified as `production-ready` in `components.json`. Reference and
experimental components remain available as source and are excluded from stable
TypeScript package exports.

Repository-wide Docker verification, GitHub automation, language packaging,
adversarial review, and release validation are complete for the `v1.0.0`
release boundary. PostgreSQL verification runs as the Supabase image's
administrative database role so pgTAP can exercise authenticated-role RLS.
Python development and runtime minimums include GitHub's patched releases for
the repository's disclosed `requests` and `pytest` advisories.
