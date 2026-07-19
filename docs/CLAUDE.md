# Docs

Engineering documentation for Web Tools: product direction, system design and settled behavior, known issues, active specs, and the story board. Human-facing project usage remains in the root [`README.md`](../README.md).

## Layout

```text
docs/
|-- PRODUCT.md       # Product intent, boundaries, and roadmap
|-- ARCHITECTURE.md  # System boundaries and request flow
|-- issues/          # Known problems with no identified solution on our side
|-- specs/           # Active specs, one per in-flight unit
|-- tasks/           # Story board
`-- _templates/      # Story, task-card, and spec scaffolds
```

## Rules

- Put a document where its primary purpose lives and cross-link instead of duplicating content.
- Keep product direction in `PRODUCT.md` and the high-level system model in `ARCHITECTURE.md`.
- Specs are temporary implementation contracts. After shipping, fold durable content into `ARCHITECTURE.md` (or `PRODUCT.md` when it changes direction), then remove the spec. Do not archive specs.
- Keep architecture and diagrams current; update or remove stale material.
- Research and source material live in [`../library/`](../library/README.md), not in engineering docs.
- Story format and status rules live in [`tasks/CLAUDE.md`](./tasks/CLAUDE.md).
- Record a problem in `issues/` only when it is real but no solution could be identified on our side. State what was investigated, the evidence, and what would unblock it. Once a fix becomes identifiable, replace the note with a story in `tasks/`.
- Copy templates from `_templates/`; do not edit a template into a real artifact.
