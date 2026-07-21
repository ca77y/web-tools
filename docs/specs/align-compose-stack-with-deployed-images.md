# Build the custom Crawl4AI image in the Compose stack

- **Status**: Draft
- **Task**: align-compose-stack-with-deployed-images
- **Last Updated**: 2026-07-21
- **Document Scope**: One unit of work: make the Compose stack build the repository's own Crawl4AI image, and reconcile the deployment documentation with the live Railway service configuration

---

## Goal

### Problem

The repository owns a custom Crawl4AI image at `services/crawl4ai/Dockerfile` that exists solely to repair an upstream boot crash: the upstream image's Playwright headless-shell binary is missing from the path Crawl4AI resolves at runtime (`/home/appuser/.cache/ms-playwright`), so the server dies with `BrowserType.launch: Executable doesn't exist`. Nothing in this repository builds that image.

- `docker-compose.yml` line 19 pulls `image: unclecode/crawl4ai:latest` — the unrepaired upstream image, at an unpinned tag. Every other repository-owned service in the file uses `build:` (`searxng` line 8, `web_tools` lines 26-28). Crawl4AI is the sole exception.
- `RAILWAY.md` documents the Crawl4AI service source as `Docker image (unclecode/crawl4ai:latest)`.

An operator following the README's "Start the local stack" gets the image the repository has already documented as broken, so local reproduction of any crawl, screenshot, PDF, or JavaScript-execution problem is not trustworthy evidence about production.

### Resolved uncertainty (established before this spec was written; do not re-investigate)

The story card flagged one unknown: is `RAILWAY.md` stale, or does the live Crawl4AI service genuinely run the unrepaired upstream image? This was resolved by reading the live Railway configuration (project `Agentic-Search`, environment `production`, service `Crawl4AI`, id `abd74fae-8f6e-4c9d-9575-ba17a2e09714`). **`RAILWAY.md` is stale.** The live service configuration is:

| Field | Live value |
| --- | --- |
| Source | GitHub repo `ca77y/web-tools` |
| Root directory | `/services/crawl4ai` |
| Builder | Railpack (builds the Dockerfile found in the root directory) |
| Health check path | `/health` |

Confirmed by the build log of the latest successful deployment (`99ea3e00-e6f7-4bf6-aa39-3fce2c2ce7c8`, commit `80fa8a60`, 2026-07-11), which executes the custom Dockerfile's repair layer and its binary guard:

```text
[2/2] RUN python -m playwright install chromium chromium-headless-shell && chown -R appuser /home/appuser/.cache && echo "--- installed playwright browsers ---" && ls -la ...
Chrome Headless Shell 149.0.7827.55 ... downloaded to /home/appuser/.cache/ms-playwright/chromium_headless_shell-1228
--- installed playwright browsers ---
/home/appuser/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell
```

So the live deployment already builds the repaired image; the documentation and the Compose file are the two sources that are wrong. **No Railway change is required or permitted by this unit** — the live configuration is correct as-is and must not be touched.

### Change

1. Point the Compose `crawl4ai` service at `build: ./services/crawl4ai`, matching how `searxng` is declared.
2. Correct the `RAILWAY.md` Crawl4AI rows to the confirmed live source.
3. Update the README so the Railway configuration section and the local-stack instructions match the resulting behavior (first `docker compose up` now builds the Crawl4AI image).

### Value

A local Compose stack that runs the same repaired, version-pinned Crawl4AI image as production, and deployment documentation an operator can follow to reproduce the live setup.

### Non-goals

- Any change to `services/crawl4ai/Dockerfile`. Its build-time browser-binary guard already works. In particular, do **not** change its `FROM unclecode/crawl4ai:0.9.1` pin.
- Any change to the Redis service pin (`redis:7-alpine` in both Compose and `RAILWAY.md` — no drift exists).
- Health-check depth, dependency readiness probes, or documenting the live `/health` health-check path. Owned by the separate `health-liveness-readiness-split` story.
- Redis runtime monitoring or alerting.
- Any change, deployment, or redeployment on Railway. This unit reads live configuration only, and that read is already done and recorded above.
- Any change to TypeScript source under `packages/`.

## Design

### `docker-compose.yml`

Replace the `image:` line of the `crawl4ai` service with a `build:` directive pointing at the service directory, leaving `ports` and `environment` untouched:

```yaml
  crawl4ai:
    build: ./services/crawl4ai
    ports:
      - "11235:11235"
    environment:
      - CRAWL4AI_API_TOKEN=${CRAWL4AI_API_TOKEN:-}
```

Use the short `build: <path>` form so the declaration is symmetric with `searxng: build: ./services/searxng`. Do **not** add an `image:` key alongside `build:` — `searxng` and `web_tools` do not have one, and adding an upstream-looking tag would reintroduce the reference this story removes. Compose names the built image after the project automatically.

Version pinning is satisfied structurally: the Dockerfile pins `FROM unclecode/crawl4ai:0.9.1`, so once Compose builds it the stack no longer resolves an unpinned `:latest` at any point.

### `RAILWAY.md`

Two places name the Crawl4AI source and both must agree with the live configuration.

1. The "Railway Service Configuration" table row. Restate it in the same shape as the SearXNG row:

   | Service | Source | Root Directory | Notes |
   | --- | --- | --- | --- |
   | Crawl4AI | GitHub repo | `services/crawl4ai` | Custom image pinned to `unclecode/crawl4ai:0.9.1`; repairs the upstream Playwright browser path |

2. The "Dependencies for Web Tools Hosting" bullet for Crawl4AI (currently "Headless browser service for page fetching, content extraction, screenshots, PDFs, and JavaScript execution"), which unlike the SearXNG bullet says nothing about where the image comes from. Extend it to name `services/crawl4ai/Dockerfile` as its build source, mirroring the SearXNG bullet's phrasing.

Write the root directory as `services/crawl4ai`, without a leading slash. Railway reports it internally as `/services/crawl4ai`, but the existing SearXNG row uses the unprefixed form and the table's own convention wins — this is deliberate normalization, not a transcription error.

Do not add a health-check column or row to the table. Leave the Redis row exactly as it is.

Both `RAILWAY.md` and `README.md` cite the GitHub repository as `arnaudjnn/web-tools`, while the live Railway service builds from `ca77y/web-tools`. That discrepancy is pre-existing and **out of scope** — leave every repository-URL line untouched.

### `README.md`

1. "Railway Configuration" currently singles out SearXNG as the service that "should build from the repo instead of a Docker image". Crawl4AI is now in exactly the same position and must be described the same way: same GitHub repo, root directory `services/crawl4ai`, with a one-line reason (the custom image repairs the upstream Playwright browser path and pins the Crawl4AI version).
2. "3. Start the local stack" and "4. Or run everything in Docker": the commands themselves do not change, but the first-run behavior does — `docker compose up` now builds the Crawl4AI (and SearXNG) images locally before starting, which takes several minutes on a cold cache. State that plainly so an operator does not read a slow first run as a hang.

Confine README edits to the "Railway Configuration" section and the "Quick Start (Local)" steps 3 and 4. Do not touch the health-endpoint or environment-variable material.

### Coordination

Three sibling stories are in flight. `health-liveness-readiness-split` also edits `README.md`, but only its health-endpoint material, and it additionally edits `docs/ARCHITECTURE.md`, which this unit does not touch. Keep this unit's README edits inside the two sections named above so the two stories do not collide. If a sibling has already landed changes in those exact sections, adapt to what is there rather than reverting it.

### Boundary

Files this unit may change:

- `docker-compose.yml`
- `RAILWAY.md`
- `README.md`
- this spec file

Files this unit must not change: `services/crawl4ai/Dockerfile`, anything under `packages/`, `docs/ARCHITECTURE.md`, `docs/PRODUCT.md`, and any story card under `docs/tasks/`.

**No test files are added or changed.** This unit changes no TypeScript; the repository's `node:test` suites live beside package source and there is no existing test that parses `docker-compose.yml`. Adding one would put deployment-topology assertions inside a transport-adapter package, violating the package boundaries in `packages/CLAUDE.md`. The acceptance scenarios below are therefore executed as Docker and Compose commands, and each one runs against the files this Boundary allows the unit to change — no scenario reaches into a package or into `services/crawl4ai/Dockerfile` (that Dockerfile is *invoked* by the build, but not modified). Evidence for each scenario is the captured command output, reported by the implementer.

### Validation

Run in this order from the repository root of the unit's worktree. `qa` must run all of them; the runtime scenarios need a working Docker daemon, which is available in this environment (Docker 29.4.0, Compose v5.1.2).

1. `docker compose config` — the merged configuration parses and resolves the build context.
2. `docker compose build crawl4ai` — the custom image builds and its final binary guard passes.
3. `docker compose up -d redis searxng crawl4ai` from a clean state, then `docker compose ps`.
4. A live crawl against `http://localhost:11235` (see the scenario below).
5. `docker compose logs crawl4ai` — no Playwright browser-launch error.
6. `pnpm build`, `pnpm typecheck`, and `pnpm test` — must still pass, confirming this unit changed nothing in the TypeScript packages. No `Dockerfile`, compose file, or CI config names `docker-compose.yml` as a build input, so there is no further consumer to build through.

Tear down with `docker compose down` when finished, leaving no containers running.

## Requirements

### Requirement: The Compose stack builds the repository's own Crawl4AI image

#### Scenario: Compose resolves Crawl4AI to a local build context

- **WHEN** `docker compose config` is run at the repository root
- **THEN** the `crawl4ai` service resolves a build context of the repository's `services/crawl4ai` directory
- **AND** the resolved `crawl4ai` service declares no `unclecode/crawl4ai` image reference

#### Scenario: No unpinned tag remains in the Compose file

- **WHEN** the `crawl4ai` service block in `docker-compose.yml` is read
- **THEN** it contains no `:latest` tag and no `image:` key
- **AND** it declares `build: ./services/crawl4ai`, matching the form used by the `searxng` service

#### Scenario: The custom image builds and its browser-binary guard passes

- **WHEN** `docker compose build crawl4ai` is run with no cached `web-tools` Crawl4AI image layers
- **THEN** the build executes `services/crawl4ai/Dockerfile` and completes successfully
- **AND** the build output contains `--- installed playwright browsers ---` followed by a resolved path ending in `chrome-headless-shell`, proving the guard found the binary

### Requirement: The built stack starts and serves a crawl

#### Scenario: The three infrastructure services reach a running state

- **WHEN** `docker compose up -d redis searxng crawl4ai` is run from a clean state
- **THEN** `docker compose ps` reports the `redis`, `searxng`, and `crawl4ai` containers in a running state
- **AND** the `crawl4ai` container is not in a restart loop

#### Scenario: A crawl succeeds with no Playwright browser-launch error

- **WHEN** a crawl request is issued against the running container at `http://localhost:11235` — `POST /md` with body `{"url": "https://example.com"}`, or `POST /crawl` with body `{"urls": ["https://example.com"]}` if the deployed Crawl4AI version exposes only the latter
- **THEN** the response is a success status carrying extracted content for that page
- **AND** `docker compose logs crawl4ai` contains no `BrowserType.launch: Executable doesn't exist` error

### Requirement: The deployment documentation states the live Crawl4AI source

#### Scenario: The RAILWAY.md service table matches the confirmed live configuration

- **WHEN** the "Railway Service Configuration" table in `RAILWAY.md` is read
- **THEN** the Crawl4AI row names a GitHub-repo source with root directory `services/crawl4ai`, in the same shape as the SearXNG row
- **AND** the row contains no `unclecode/crawl4ai:latest` reference
- **AND** the Redis row is unchanged at `redis:7-alpine`

#### Scenario: The RAILWAY.md dependency bullet names the build source

- **WHEN** the Crawl4AI bullet under "Dependencies for Web Tools Hosting" is read
- **THEN** it names `services/crawl4ai/Dockerfile` as the image's build source, mirroring how the SearXNG bullet names `services/searxng/Dockerfile`

### Requirement: The README matches the resulting commands and first-run behavior

#### Scenario: The Railway configuration section covers Crawl4AI

- **WHEN** the "Railway Configuration" section of `README.md` is read
- **THEN** it states that the Crawl4AI service builds from the same GitHub repo with root directory `services/crawl4ai`, alongside the existing SearXNG instructions
- **AND** it gives the reason: the custom image repairs the upstream Playwright browser path and pins the Crawl4AI version

#### Scenario: The local-stack section describes first-run build behavior

- **WHEN** "3. Start the local stack" and "4. Or run everything in Docker" are read
- **THEN** the documented commands are exactly the commands that work against the changed `docker-compose.yml`
- **AND** the text states that the first run builds the Crawl4AI and SearXNG images locally and therefore takes noticeably longer than a pull

#### Scenario: Out-of-scope material is untouched

- **WHEN** the unit's full diff is reviewed
- **THEN** it changes only `docker-compose.yml`, `RAILWAY.md`, `README.md`, and this spec file
- **AND** `services/crawl4ai/Dockerfile` and its `unclecode/crawl4ai:0.9.1` pin are unchanged
- **AND** no health-check endpoint, probe, or readiness material is added anywhere

### Requirement: The TypeScript packages are unaffected

#### Scenario: The repository validation suite still passes

- **WHEN** `pnpm build`, `pnpm typecheck`, and `pnpm test` are run at the repository root
- **THEN** all three succeed
- **AND** no test file was added, removed, or modified by this unit

## Tasks

- [ ] Change the `crawl4ai` service in `docker-compose.yml` from `image: unclecode/crawl4ai:latest` to `build: ./services/crawl4ai`, leaving `ports` and `environment` as they are.
- [ ] Run `docker compose config` and confirm the build context resolves to `services/crawl4ai` and that the resolved `crawl4ai` service carries no `unclecode/crawl4ai` image reference.
- [ ] Re-read the `crawl4ai` block in `docker-compose.yml` and confirm it has no `image:` key and no `:latest` tag.
- [ ] Run `docker compose build crawl4ai` and capture the `--- installed playwright browsers ---` guard output.
- [ ] Run `docker compose up -d redis searxng crawl4ai` from a clean state and confirm all three containers are running.
- [ ] Issue a crawl against `http://localhost:11235`, capture the successful response, and confirm `docker compose logs crawl4ai` shows no `BrowserType.launch` error. Tear the stack down afterwards.
- [ ] Update the `RAILWAY.md` "Railway Service Configuration" Crawl4AI row to the confirmed live source (GitHub repo, root directory `services/crawl4ai`).
- [ ] Extend the `RAILWAY.md` Crawl4AI dependency bullet to name `services/crawl4ai/Dockerfile` as the build source.
- [ ] Add Crawl4AI to the README "Railway Configuration" section alongside SearXNG, with the reason for the custom image.
- [ ] Note the first-run local build behavior in README "Start the local stack" / "Or run everything in Docker".
- [ ] Run `pnpm build`, `pnpm typecheck`, and `pnpm test` and confirm they pass.
- [ ] Confirm the diff touches only the four files named in the Boundary.
