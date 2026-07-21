---
type: story
title: Build the custom Crawl4AI image in the Compose stack
---

# Build the custom Crawl4AI image in the Compose stack

- [<] Build the custom Crawl4AI image in the Compose stack #bug ⏫ 🆔 align-compose-stack-with-deployed-images
  - Phase: Phase 3 - Operable Service
  - Problem: the repository owns a custom Crawl4AI image at [`services/crawl4ai/Dockerfile`](../../services/crawl4ai/Dockerfile) that exists solely to repair a boot crash in the upstream image, but no configuration in this repository ever builds it.
    - [`docker-compose.yml`](../../docker-compose.yml) line 19 sets the Crawl4AI service to `image: unclecode/crawl4ai:latest` — the unrepaired upstream image. Every other repository-owned service in that file uses `build:` (`searxng` at line 8, `web_tools` at lines 26-28). Crawl4AI is the sole exception.
    - [`../../RAILWAY.md`](../../RAILWAY.md), in its "Railway Service Configuration" table, likewise documents the Crawl4AI service source as `Docker image (unclecode/crawl4ai:latest)` with no root directory, while it lists SearXNG as a GitHub-repo build with root directory `services/searxng`. So both the local and the documented deployment path point at the upstream image, and `services/crawl4ai/Dockerfile` is referenced by neither.
    - The custom Dockerfile's header comment records the defect it fixes: the upstream image's Playwright headless-shell binary is absent from the path Crawl4AI resolves at runtime (`/home/appuser/.cache/ms-playwright`), so the server crashes on boot with `playwright._impl._errors.Error: BrowserType.launch: Executable doesn't exist at .../chromium_headless_shell-<rev>/.../chrome-headless-shell`. It reinstalls the browsers to that exact path using the same Python/Playwright the server imports, then ends with an `ls` of the resolved binary so a green build guarantees the binary is present.
    - The custom image also pins `FROM unclecode/crawl4ai:0.9.1` (Dockerfile line 14), whereas the Compose and `RAILWAY.md` references are the unpinned `:latest`, so the Crawl4AI version in use drifts silently.
  - Impact: [`../../README.md`](../../README.md) documents Compose as the supported local path in "Start the local stack" (`docker compose up -d redis searxng crawl4ai`) and "Or run everything in Docker" (`docker compose up`). An operator following the README gets the upstream image the repository has already documented as broken on browser launch, so local reproduction of any crawl, screenshot, PDF, or JavaScript-execution problem runs against an unpinned and potentially crash-on-boot Crawl4AI.
  - Known uncertainty to resolve as the first step of this story: the repository contains a fix Dockerfile and recent `fix(crawl4ai):` commits repairing the Playwright browser path, which implies the live deployment builds it, yet `RAILWAY.md` still documents the plain upstream image. Whether `RAILWAY.md` is stale or the live Crawl4AI service genuinely runs the unrepaired upstream image is not determinable from this repository alone. Confirm against the live Railway service configuration before editing, and correct whichever source is wrong.
  - Reproduction:
    - From a clean Docker state with no cached `unclecode/crawl4ai` image, run `docker compose up crawl4ai` at the repository root.
    - Observe that Compose pulls `unclecode/crawl4ai:latest` and never builds `./services/crawl4ai`.
    - Issue a crawl against the container at `http://localhost:11235` and observe the Playwright `BrowserType.launch: Executable doesn't exist` failure whenever the pulled image ships the mismatched browser path.
    - Contrast with `docker build ./services/crawl4ai`, whose final `ls` of `/home/appuser/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell` fails the build unless the binary resolves.
  - Expected behavior: the repository's own Crawl4AI image is the one the Compose stack runs, and the documented deployment configuration agrees with it, so a local reproduction is trustworthy evidence about production.
  - Scope:
    - Point the Compose `crawl4ai` service at `build: ./services/crawl4ai` instead of the unpinned upstream `image:` reference.
    - Reconcile the `RAILWAY.md` service table with the confirmed live Crawl4AI service source.
    - Update the README local-stack instructions if the commands or first-run build behavior change.
    - Out of scope: any change to `services/crawl4ai/Dockerfile` itself — its build-time browser-binary guard already works and needs no repair. Also out of scope: the Redis service pin (Compose line 3 and the `RAILWAY.md` table both specify `redis:7-alpine`, so there is no drift to fix), health-check depth or dependency readiness probes (covered by the separate `health-liveness-readiness-split` story), and Redis runtime monitoring or alerting.
  - Acceptance criteria:
    - `docker-compose.yml` builds the Crawl4AI service from `./services/crawl4ai` rather than pulling `unclecode/crawl4ai:latest`.
    - The Crawl4AI service in `docker-compose.yml` no longer references an unpinned `:latest` tag.
    - `docker compose up -d redis searxng crawl4ai` from a clean state brings all three containers to a running state, and the Crawl4AI container serves a successful crawl with no Playwright browser-launch error.
    - The `RAILWAY.md` "Railway Service Configuration" table states the Crawl4AI source that the live service actually uses, confirmed against the deployment rather than inferred.
    - The README local-stack section matches the resulting commands and first-run build behavior.
  - References:
    - [`../../docker-compose.yml`](../../docker-compose.yml) - line 3 (Redis pin), lines 18-23 (Crawl4AI upstream image), lines 8 and 26-28 (the `build:` services)
    - [`../../services/crawl4ai/Dockerfile`](../../services/crawl4ai/Dockerfile) - the custom image, the defect it documents, and its build-time binary guard
    - [`../../RAILWAY.md`](../../RAILWAY.md) - "Railway Service Configuration" table
    - [`../../README.md`](../../README.md) - "Start the local stack" and "Or run everything in Docker"
    - [`../ARCHITECTURE.md`](../ARCHITECTURE.md) - the four owned services and the Crawl4AI boundary
    - [`../PRODUCT.md`](../PRODUCT.md) - Phase 3, deployment guidance covering configuration and service dependencies
