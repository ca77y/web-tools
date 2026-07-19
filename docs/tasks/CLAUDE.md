# Tasks

Local work tracking in plain Markdown. One story is one substantial, self-contained, shippable unit: one story, one card, one file, and one pull request. A prerequisite is a separate linked story, not a child task.

## Files

- `<slug>.md` - one active story file with `type: story` frontmatter
- `_archive/` - completed or cancelled stories no longer needed on the live board
- `_backlog/` - parked ideas that are not active board commitments

## Card format

Use one Obsidian Tasks-compatible checkbox in the format supplied by [`../_templates/story.md`](../_templates/story.md). Put scope, acceptance criteria, and links on indented sub-bullets. Link research, docs, code, and an in-flight spec rather than pasting their content.

- **Status**: `[ ]` Todo (Backlogs column), `[<]` Ready to start, `[/]` In Progress, `[?]` In Review, `[x]` Done, `[X]` Completed, `[-]` Cancelled
- **Type**: exactly one of `#feature`, `#improvement`, `#bug`, `#research`, `#marketing`, or `#support`
- **Priority**: `🔺` highest, `⏫` high, `🔼` medium, `🔽` low
- **Dependencies**: `🆔 <slug>` declares the story ID; a dependent card uses `⛔ <slug>`

Only feature, improvement, and bug stories are implementation-ready. Research, marketing, and support cards must first be refined into an implementation story.

## Rules

- The checkbox symbol is the source of truth for status; do not duplicate status in frontmatter.
- Frontmatter contains only `type` and `title`.
- New cards start Todo. Move a refined, unblocked card to Ready to start. The lead moves invoked work to In Progress and In Review; the human owner moves merged work to Done.
- Add `Phase: Phase N - Name` on the next indented line when a story belongs to a delivery phase in [`../PRODUCT.md`](../PRODUCT.md).
- Copy [`../_templates/story.md`](../_templates/story.md) for new stories.
- Keep examples and template checkboxes outside `docs/tasks/` so the Task Board does not scan them as real work.
