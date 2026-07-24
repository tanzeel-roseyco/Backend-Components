# Component index

The live component index is the repository tree. Every production source file
has a README beside it, using the same base name:

```text
component.ts
component.README.md
```

Python, Go, and JavaScript components follow the same convention. The three
tenant RLS SQL files form one component and use
`shared/sql/tenant-rls-reference.README.md`.

Use the root [README](../../README.md) to choose a category, then read the
sidecar README before copying code. Provenance for the most recent standardized
components is recorded in [BORROW-INVENTORY.md](../../BORROW-INVENTORY.md).

This file deliberately avoids a hand-maintained feature matrix. Those matrices
become inaccurate when components are added or changed, while the adjacent
READMEs can be reviewed with the code they describe.
