---
type: story
title: Tie the Crawl4AI forbidden-field lists to the pinned image version
---

# Tie the Crawl4AI forbidden-field lists to the pinned image version

- [ ] Tie the Crawl4AI forbidden-field lists to the pinned image version #improvement 🔼 🆔 tie-crawl4ai-forbidden-fields-to-pinned-image
  - Problem: the forbidden-key sets for `BrowserConfig` and `CrawlerRunConfig` in `packages/toolkit/src/crawl4ai.ts` are hand-transcribed from what `unclecode/crawl4ai:0.9.1` rejects. The tests and `docs/ARCHITECTURE.md` re-transcribe the same lists. That arrangement catches a typo (the copies disagree) but not a version bump: nothing connects these sets to the image version actually pinned in `services/crawl4ai/`, so upgrading the image can silently invalidate every entry while the whole suite stays green. The only current safeguard is a `// Revisit … whenever the pinned image is bumped` comment.
  - Failure mode: a future image bump changes which keys the upstream request model accepts. Web Tools keeps rejecting keys that are now legal (callers get a pre-flight error for a working feature) or keeps forwarding keys that are now forbidden (the opaque upstream `400` this story class was created to eliminate returns). Nothing fails until production traffic hits it.
  - Scope:
    - Co-locate the pinned Crawl4AI image version with the forbidden-field sets so they are visibly one unit, and assert the version the sets were derived from matches the version `services/crawl4ai/` pins.
    - Decide and document what "revisit" means operationally when the assert fires — where the authoritative list is re-derived from, and who owns it.
    - Consider deriving the lists from a single source consumed by code, tests, and docs, instead of three transcriptions.
  - Acceptance criteria:
    - Bumping the pinned Crawl4AI image version without revisiting the forbidden-field sets fails a test, with a message naming what to re-derive.
    - The forbidden-field sets have exactly one authoritative definition; tests and docs derive from it or assert against it rather than restating it.
  - Source: review of PR #2 (`story/normalize-crawl4ai-config-payloads`), finding 3 — flagged as follow-up-grade, not blocking that story.
