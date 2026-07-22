---
type: story
title: Prune the web_fetch filter parameters the handler never reads
---

# Prune the web_fetch filter parameters the handler never reads

- [ ] Prune the web_fetch filter parameters the handler never reads #improvement 🔼 🆔 prune-dead-web-fetch-filter-params
  - Problem (proven): `WebFetchInput` (`packages/toolkit/src/schemas.ts`) declares `q`, `c`, `provider`, `temperature`, and `base_url`, each with a description promising behaviour — "Query string for BM25/LLM filters", "Enable caching for the request", "LLM provider for LLM filter", "Temperature for LLM filter", "Base URL override for the LLM provider". The `web_fetch` handler (`packages/toolkit/src/functions.ts`) reads **only** `url`, `f`, and `delay`. A repository-wide grep for non-test reads of `params.q`, `params.c`, `params.provider`, `params.temperature`, and `params.base_url` returns nothing. Every one of these is silently ignored: a caller setting `f: 'bm25'` and `q: '...'` gets the default `fit` filter behaviour with no error and no filtering.
  - Why it matters: this is the same defect class that [`normalize-crawl4ai-config-payloads`](./normalize-crawl4ai-config-payloads.md) fixed for Crawl4AI config keys — the published schema must not advertise what cannot work. That story deliberately scoped itself to the config envelope and left the filter params alone; this card is the remainder.
  - Scope:
    - Decide per parameter: implement it, or remove it from `WebFetchInput`.
    - `f` itself is only partly live: `packages/toolkit/src/functions.ts:211` selects `raw_markdown` when `f === 'raw'` and `fit_markdown` otherwise, so `raw` and `fit` work, but `bm25` and `llm` are accepted by the enum and behave identically to `fit`. The four dead parameters exist to serve exactly those two unimplemented strategies, so resolve the `f` enum in the same decision rather than separately.
    - Update `docs/ARCHITECTURE.md` if the published `web_fetch` contract changes.
  - Acceptance criteria:
    - Every parameter `WebFetchInput` declares is either read by the handler or gone from the schema.
    - A test asserts the schema declares no parameter the handler does not read, so the drift cannot silently return.
    - The comment in `packages/toolkit/src/schemas.test.ts` that currently points at this card is updated or removed.
  - Source: review of PR #2 (`story/normalize-crawl4ai-config-payloads`), finding 2 — raised as explicitly out of scope for that story and deferred here.
