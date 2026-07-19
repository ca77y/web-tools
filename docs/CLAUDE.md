# Docs

Engineering documentation for Web Tools: product direction, system design, settled behavior, operational flows, active specs, and the story board. Human-facing project usage remains in the root [`README.md`](../README.md).

## Layout

```text
docs/
|-- PRODUCT.md       # Product intent, boundaries, and roadmap
|-- ARCHITECTURE.md  # System boundaries and request flow
|-- designs/         # Architecture, deployment, and operational design
|-- features/        # Settled capability behavior and contracts
|-- flows/           # End-to-end request/operator flows
|-- specs/           # Active specs, one per in-flight unit
|-- tasks/           # Story board
`-- _templates/      # Story, task-card, and spec scaffolds
```

## Rules

- Put a document where its primary purpose lives and cross-link instead of duplicating content.
- Keep product direction in `PRODUCT.md` and the high-level system model in `ARCHITECTURE.md`.
- Specs are temporary implementation contracts. After shipping, fold durable content into `features/`, `flows/`, or `designs/`, then remove the spec. Do not archive specs.
- Keep architecture and diagrams current; update or remove stale material.
- Research and source material live in [`../library/`](../library/README.md), not in engineering docs.
- Story format and status rules live in [`tasks/CLAUDE.md`](./tasks/CLAUDE.md).
- Copy templates from `_templates/`; do not edit a template into a real artifact.
