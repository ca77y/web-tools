# Docs

Engineering documentation for product direction, system design, settled behavior, operational flows, active specs, and story tracking. Human-facing setup remains in the root `README.md`.

## Placement

- Keep product intent and roadmap in `PRODUCT.md`.
- Keep the high-level system model in `ARCHITECTURE.md`.
- Put focused architecture, deployment, and operational decisions in `designs/`.
- Put shipped capability contracts in `features/` and end-to-end behavior in `flows/`.
- Keep temporary implementation contracts in `specs/` and active stories in `tasks/`.

## Rules

- Cross-link instead of duplicating the same contract.
- After shipping, fold durable spec content into permanent docs and remove the spec; do not archive specs.
- Keep architecture and diagrams current; update or remove stale material.
- Keep research and source material in `../library/`; research is evidence, not implementation authority.
- Use lowercase kebab-case for documentation filenames except repository landmarks such as `PRODUCT.md`, `ARCHITECTURE.md`, `README.md`, `CLAUDE.md`, and `AGENTS.md`.
- Follow the nearest scoped `AGENTS.md` under `tasks/` or `_templates/`.
