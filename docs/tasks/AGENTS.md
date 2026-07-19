# Tasks

Store one active story in each `<slug>.md` file. Completed or cancelled stories move to `_archive/`; parked ideas move to `_backlog/`.

## Card Rules

- Copy `../_templates/story.md` and keep exactly one Obsidian Tasks-compatible checkbox per story.
- Use `[ ]` Todo, `[<]` Ready to start, `[/]` In Progress, `[?]` In Review, `[x]` Done, `[X]` Completed, and `[-]` Cancelled.
- Todo is proposed but unrefined. Ready to start has clear acceptance criteria and no unresolved blocker.
- Use exactly one type and priority. Declare dependencies by story ID.
- Add the matching phase from `../PRODUCT.md` when applicable.
- Keep one story, one card, one file, and one pull request. Model prerequisites as linked stories, not child tasks.
- Keep examples and templates outside this directory so Task Board does not scan them as work.

See `CLAUDE.md` for the complete card syntax and tag vocabulary.
