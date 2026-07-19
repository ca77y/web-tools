# Librarian Instructions

**Status**: Active
**Last Updated**: 2026-07-19
**Document Scope**: Shared operating rules for the Web Tools research library

---

## Role

Maintain `library/` as a Markdown-first research wiki. Role-specific workflows come from the librarian, scribe, clerk, or researcher agent; these conventions apply to every library operation.

## Constraints

- Route all library work through the library/research agents.
- Research is evidence, not a product or architecture decision. Decisions belong in `docs/` or the root `README.md`.
- Preserve `library/raw/`; synthesis never overwrites source notes.
- Never inspect or output secrets or `.env` files.
- Keep core content meaningful as plain Markdown even when plugins are unavailable.

## Obsidian conventions

1. Use wikilinks for internal pages and Markdown links for external URLs.
2. Index every raw and wiki content page in `_meta/index.md`, with a plain-Markdown fallback even when Dataview also lists it.
3. Use block IDs and links such as `[[source-note#^claim-id]]` for granular citations.
4. Give content pages frontmatter with `title`, `type`, `tags`, `aliases`, `created`, `updated`, `up`, and `related`. Raw notes also record `source` and `accessed`; wiki pages record `confidence`.
5. Register every tag in `_meta/taxonomy.md`; use lowercase kebab-case.
6. Use Obsidian callouts for summaries, source excerpts, caveats, and open questions.
7. Remove all template placeholders before finishing a page.
8. Update `_meta/log.md` after ingest, synthesis, taxonomy, or maintenance work.
9. Clean up temporary helper files before handing work back.

## Plugins

- **Dataview**: query frontmatter, but retain a plain-Markdown index fallback.
- **Breadcrumbs**: use valid `up` and `related` wikilinks for page relationships.

## Templates

- Obsidian Templater is configured for the engineering scaffolds in `docs/_templates/`, as required by the story pipeline.
- Library agents copy `_meta/templates/raw-note.md`, `wiki-page.md`, or `topic-moc.md` directly so research templates remain next to the library conventions and work without plugin configuration.
