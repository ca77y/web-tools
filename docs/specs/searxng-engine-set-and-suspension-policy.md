# Restrict the SearXNG engine set and bound engine failure suspension

- **Status**: Draft
- **Task**: searxng-engine-set-and-suspension-policy
- **Last Updated**: 2026-07-23
- **Document Scope**: One unit of work — restrict SearXNG's active engine set to an explicit allowlist and replace the blanket zero-suspension policy with a bounded, differentiated one, without changing `packages/`, the proxy/egress path, or `web_search`'s caller contract.

---

## Goal

Our SearXNG instance runs engines we never configured (`wikidata`, `google cse`, `startpage` — 41% of non-timeout failures in the production sample) and retries permanently-blocked engines on every search forever, because [`services/searxng/settings.yml`](../../services/searxng/settings.yml) sets the scalar `use_default_settings: true` (which does **not** restrict the engine set) and zeroes the entire suspension/ban system.

**Change.** Two edits to `services/searxng/settings.yml`, plus a static structural test:

1. Replace the scalar `use_default_settings: true` (line 1) with the mapping form carrying an explicit `engines.keep_only` allowlist, so only the seven intended engines load.
2. Replace the blanket-zero `search.suspended_times` / `ban_time_on_fail` / `max_ban_time_on_fail` block (lines 15–24) with bounded, differentiated, per-class values, each carrying an in-file comment.

**Value.** Eliminates ~41% of the failure volume outright (unintended engines), and converts the unbounded per-search retry storm against blocked engines into a bounded circuit breaker (order of minutes), reducing the outbound-request amplification that contributes to our egress being blocked.

**Non-goals.**
- No change to `packages/toolkit` (client fan-out and timeout budget belong to [`search-client-fanout-and-timeout-budget`](../tasks/search-client-fanout-and-timeout-budget.md)).
- No change to the proxy/egress provider (egress reputation is tracked in [`../issues/searxng-egress-proxy-reputation.md`](../issues/searxng-egress-proxy-reputation.md); this story reduces avoidable load, it does not claim to fix reputation).
- No change to how `web_search` reports failure to callers.
- No change to `outgoing.retries`, the `outgoing.proxies` block, or `google_sorry_fix.py` — these are **preservation constraints** (see Design).

## Design

### Boundary

- **Files changed:** `services/searxng/settings.yml` (the only product-config change) and a new dependency-free static test `services/searxng/settings.test.mjs`, wired into the root `test` script.
- **Files that must NOT change (preservation constraints):** `services/searxng/Dockerfile`, `services/searxng/google_sorry_fix.py`, and the `outgoing:` block of `settings.yml` (lines 26–53, including the `proxies:` sub-block).
- **Test-execution boundary.** Static/structural scenarios run with Node ≥ 24 over the checked-in `settings.yml` text (no container, no network, no added dependency). Runtime scenarios (`GET /config`, live search, `PROXY_URL`-unset boot, image build) run against the SearXNG image built from `services/searxng/` and require a container runtime plus network access to pull the `searxng/searxng:latest` base image; they are owned by QA/acceptance, not by the coder's automated suite (see Tasks). The Boundary for those scenarios therefore explicitly includes the SearXNG container runtime.

### Edit 1 — restrict the engine set

Replace line 1:

```yaml
use_default_settings: true
```

with the mapping form:

```yaml
use_default_settings:
  engines:
    keep_only:
      - google
      - brave
      - duckduckgo
      - bing
      - qwant
      - mojeek
      - wikipedia
```

Per the [upstream docs](https://docs.searxng.org/admin/settings/settings.html#use-default-settings), the scalar `true` merges the local `engines:` list as per-engine *overrides* on top of the full default engine set — it is not an allowlist. The `keep_only` mapping form is the documented mechanism that restricts the set. The two forms are alternatives, not additive: the scalar is removed.

The existing local `engines:` list (lines 55–93) is **kept unchanged**. `keep_only` restricts *which* default engines load; the local `engines:` entries continue to merge per-engine overrides (`shortcut`, `use_mobile_ui`, `disabled`) onto them by `name`. The two are complementary. The seven `keep_only` names are exactly the seven names already present in that list.

**Engine-set decision — keep all seven, including `mojeek` and `qwant`.** The card caveat and [`../issues/searxng-egress-proxy-reputation.md`](../issues/searxng-egress-proxy-reputation.md) establish that Mojeek's 403 and Qwant's access-denied are a *well-evidenced but unconfirmed* egress-reputation hypothesis (the discriminating experiment has not been run), not a configuration defect. Dropping them would prejudge an unproven diagnosis and permanently narrow result coverage for a problem a proxy/pool change could fix. Default is therefore **keep and suspend on failure**: both stay in `keep_only`, and the new `SearxEngineAccessDenied` bound (below) stops their per-search retry storm without removing them.

### Edit 2 — differentiated, bounded suspension policy

Replace lines 15–24 (the comment plus the `suspended_times`/`ban_time_on_fail`/`max_ban_time_on_fail` block) with:

```yaml
  suspended_times:
    # Class-keyed DEFAULT suspend durations (seconds). SearXNG applies these
    # per-engine-network (see searx/search/processors/abstract.py:
    # SUSPENDED_STATUS is keyed by the engine's network, not by exception
    # class), and only when an engine raises the class WITHOUT an explicit
    # suspended_time. Suspension is checked at search dispatch and skips the
    # engine on SUBSEQUENT searches; it never interrupts the in-search
    # outgoing.retries rotation, which lives at the network layer.
    #
    # Ordering reflects how exit-IP-rotation-recoverable each class is:
    # a fresh rotating exit IP fixes a CAPTCHA, may not fix a rate-limit, and
    # usually will not fix a per-ASN/fingerprint 403 — so re-test soonest for
    # CAPTCHA, latest for AccessDenied.

    # CAPTCHA is the most rotation-recoverable class (a clean exit IP clears a
    # Google /sorry/ block). The immediate-retry paths this rotation depends on
    # — google_sorry_fix.py's 302 patch and duckduckgo.py's two CAPTCHA paths —
    # raise SearxEngineCaptchaException(suspended_time=0) EXPLICITLY, so they
    # bypass this value and self-suspend for 0s regardless. 60s therefore only
    # bounds residual bare CAPTCHA raises (e.g. Google's upstream non-302
    # detect_google_sorry), giving them a minimal circuit breaker.
    SearxEngineCaptcha: 60
    # 429 / "too many requests" (brave, wikipedia) is largely volume-driven and
    # decays with time; 2 min lets the rate window drain and re-tests quickly
    # because these are core engines. Upstream default is 3600 (1h).
    SearxEngineTooManyRequests: 120
    # 403 / access-denied (mojeek, qwant on first contact) points at per-ASN /
    # fingerprint reputation that a fresh exit IP will NOT fix; suspend longest
    # so we stop hammering, but only 5 min (not upstream's 86400 = 24h) because
    # our rotating residential pool's standing can change and is worth re-testing.
    SearxEngineAccessDenied: 300
    # Cloudflare / reCAPTCHA challenges are per-fingerprint/session, not exit-IP
    # rotation-recoverable, so treat them like durable access-denied. None of the
    # seven allowlisted engines raise these today; bounding them prevents ever
    # inheriting upstream's 15-day / 7-day / 1-day defaults if one starts to.
    cf_SearxEngineCaptcha: 300
    cf_SearxEngineAccessDenied: 300
    recaptcha_SearxEngineCaptcha: 300
  # Generic per-fail ban for failures with no class-specific suspended_time
  # (timeouts, connection resets, non-access-denied errors). SearXNG uses
  # min(max_ban_time_on_fail, ban_time_on_fail), so the effective ban is 5s: a
  # minimal cooldown that stops a timing-out engine (duckduckgo: 117 timeouts in
  # the sample) from being re-queried on the immediately following search, while
  # recovering almost instantly since these failures are usually transient. The
  # timeout storm itself is owned by search-client-fanout-and-timeout-budget.
  ban_time_on_fail: 5
  max_ban_time_on_fail: 120
```

**How this satisfies the card's differentiated-policy intent** (with the mechanism corrected against the SearXNG source):

- `suspended_times.<Class>` is a **class-keyed default duration**, consulted only when an engine raises that class with no explicit time. It is not a per-engine control. Suspension *state* is stored per-engine-network, so bounding a class never causes one engine's failure to suspend another.
- The rotation-recovery paths the card worried about (Google `/sorry/` via `google_sorry_fix.py`, and DuckDuckGo's CAPTCHA) raise with an **explicit** `suspended_time=0` in code, so they are immune to `SearxEngineCaptcha` and continue to self-suspend for 0s. Raising `SearxEngineCaptcha` from 0 to 60 therefore does **not** break rotation — confirmed against `searx/exceptions.py` (`if suspended_time is None`, not `0 or default`), `searx/search/processors/online.py`, and `searx/engines/duckduckgo.py`.
- The `outgoing.retries: 3` rotation loop is a **network-layer** concern (`searx/network/network.py: Network.call_client`) that wraps only the HTTP request and does not re-invoke `engine.response()`; suspension is evaluated only at search dispatch. The two never interact within a single search, so no suspension value can shorten or lengthen the in-search rotation.

### Preservation constraints (must hold after the edits)

- **`google_sorry_fix.py` unchanged.** It is not a change target. The Dockerfile `RUN` that applies it is unchanged.
- **`outgoing.proxies` block unchanged and still `sed`-strippable.** The `PROXY_URL`-unset entrypoint branch runs `sed '/proxies:/,/PROXY_URL}/d'` over the template. Both edits are above and outside the `outgoing:` block, so the `sed` range (first `proxies:` line through first `PROXY_URL}` line — currently lines 45–53) is unchanged. The coder must verify: the strings `proxies:` and `PROXY_URL}` each occur exactly once in the file, both inside `outgoing:` and after the `suspended_times` block, and the new `keep_only`/`suspended_times` content introduces neither string.
- **`outgoing.retries: 3`, `request_timeout`, `pool_*`, `verify` unchanged.**

### Deviations from the card

1. **The card's model that `suspended_times.SearxEngineCaptcha` governs DuckDuckGo's (and Google's 302) CAPTCHA is incorrect for those two engines.** In current SearXNG both raise `SearxEngineCaptchaException(suspended_time=0)` explicitly, bypassing the config. DuckDuckGo's CAPTCHA suspension is therefore **not** config-controllable and is intentionally left at its upstream code behavior (0s — deliberate: "ddg does not block the IP"). This is not a gap: DuckDuckGo's *material* failure mode in the evidence is timeouts (117), which are bounded by `ban_time_on_fail`, not CAPTCHA (6).
2. **The card suggests keeping `SearxEngineCaptcha` at 0 for the Google `/sorry/` path.** We instead set it to a very small non-zero value (60s), honoring the card's "0 or a very small value" allowance, because the `/sorry/` path's 0-suspension is guaranteed in code (explicit argument), so the config value is free to give residual bare-CAPTCHA raises a real circuit breaker at no cost to rotation. No `suspended_times` key is left at 0; the "why zero was kept" rationale the card anticipated now lives in code (the explicit `suspended_time=0` arguments) and is documented in the in-file comment.

### Coordination

- **Shared root `test` script.** [`search-client-fanout-and-timeout-budget`](../tasks/search-client-fanout-and-timeout-budget.md) states "the repository currently has no test runner … and no `test` script in the root `package.json`." That claim is **stale**: `packages/toolkit` already has `*.test.ts` and a working `node --test` setup, and the root `package.json` already has a `test` script running all three packages. Both stories nonetheless touch the root `test` script. If that sibling lands first and restructures the root `test` script, detect and extend its structure rather than reverting it; if this story lands first, the sibling should do likewise. This spec adds a separate `test:searxng` script and appends it to `test` (see Tasks) to minimize collision surface.

### Documentation landing (docs pass, not this build)

The chosen engine set and suspension policy, with rationale, are recorded during the docs pass in [`../ARCHITECTURE.md`](../ARCHITECTURE.md) under the **SearXNG** section (currently lines ~89–95). That is owned by the writer's docs pass, not the coder (see Tasks).

## Requirements

### Requirement: The active engine set is exactly the seven-engine allowlist

#### Scenario: keep_only carries the mapping form and the seven intended engines

- **WHEN** the static test parses `services/searxng/settings.yml`
- **THEN** `use_default_settings` is a mapping (not the scalar `true`) whose `engines.keep_only` list contains exactly `google`, `brave`, `duckduckgo`, `bing`, `qwant`, `mojeek`, `wikipedia` (set equality, order-independent), and the local `engines:` list names are a subset of that allowlist

#### Scenario: unintended engines are absent from the allowlist

- **WHEN** the static test inspects `engines.keep_only`
- **THEN** `wikidata`, `google cse` (`google_cse`), and `startpage` are not present

#### Scenario: the running service reports only allowlisted engines

- **WHEN** the SearXNG image is built and started and `GET /config` is queried (`curl -s localhost:8080/config | jq -r '.engines[].name'`)
- **THEN** the returned engine names are exactly the seven allowlisted engines and include none of `wikidata`, `google cse`, `startpage` *(runtime scenario — QA/acceptance-owned)*

### Requirement: Engine-failure suspension is bounded and differentiated by class

#### Scenario: durable-block classes are bounded non-zero

- **WHEN** the static test reads `search.suspended_times`
- **THEN** `SearxEngineAccessDenied`, `SearxEngineTooManyRequests`, `SearxEngineCaptcha`, `cf_SearxEngineCaptcha`, `cf_SearxEngineAccessDenied`, and `recaptcha_SearxEngineCaptcha` are each a positive integer strictly greater than 0 and strictly less than the upstream 24-hour default (86400)

#### Scenario: suspension durations follow the rotation-recoverability ordering

- **WHEN** the static test reads `search.suspended_times`
- **THEN** `SearxEngineCaptcha` < `SearxEngineTooManyRequests` < `SearxEngineAccessDenied`

#### Scenario: the generic per-fail ban is bounded non-zero

- **WHEN** the static test reads `search.ban_time_on_fail` and `search.max_ban_time_on_fail`
- **THEN** `ban_time_on_fail` is greater than 0 and `max_ban_time_on_fail` is greater than or equal to `ban_time_on_fail`

#### Scenario: every suspension value carries an explanatory comment

- **WHEN** the static test scans the text of the `suspended_times` block and the `ban_time_on_fail` / `max_ban_time_on_fail` lines
- **THEN** the block contains `#` comment lines explaining why each class is suspended and why the CAPTCHA class is kept small, so no value stands without a stated rationale

#### Scenario: rotation-recovery CAPTCHA paths are unaffected by the CAPTCHA bound

- **WHEN** the design's claim that `google_sorry_fix.py`'s 302 path and DuckDuckGo's CAPTCHA paths self-suspend for 0s is checked
- **THEN** it is confirmed by inspection that both raise `SearxEngineCaptchaException(suspended_time=0)` with an explicit argument (`google_sorry_fix.py` and upstream `searx/engines/duckduckgo.py`), so the `SearxEngineCaptcha: 60` default never applies to them *(covered by inspection — this behavior lives in the upstream image and the preserved patch, not in a file this task can unit-test)*

### Requirement: The proxy-injection entrypoint and Google patch are preserved

#### Scenario: the entrypoint sed range is intact

- **WHEN** the static test scans `settings.yml`
- **THEN** the strings `proxies:` and `PROXY_URL}` each occur exactly once, both appear after the `suspended_times` block, and neither appears in the `use_default_settings`/`keep_only` or `suspended_times` content

#### Scenario: google_sorry_fix.py is not modified

- **WHEN** the change is reviewed
- **THEN** `services/searxng/google_sorry_fix.py` and the Dockerfile `RUN`/`ENTRYPOINT` are byte-for-byte unchanged from the base branch

#### Scenario: the container boots with PROXY_URL unset and renders valid settings

- **WHEN** the SearXNG image is built and run with `PROXY_URL` unset (e.g. `docker compose up searxng redis` with no `PROXY_URL`)
- **THEN** the container logs `Proxy: disabled`, starts successfully (SearXNG parses the rendered `settings.yml` on boot — invalid YAML would crash the process), and the rendered `/etc/searxng/settings.yml` contains no `proxies:` block *(runtime scenario — QA/acceptance-owned)*

### Requirement: Working engines still return results

#### Scenario: a live search returns results

- **WHEN** the stack is running and `curl -s 'localhost:8080/search?q=Railway+cloud+deployment+platform&format=json' | jq '.results | length'` is issued
- **THEN** the result count is greater than 0, confirming the allowlist did not disable the working engines *(runtime scenario — QA/acceptance-owned)*

### Requirement: The SearXNG image still builds

#### Scenario: image build succeeds through the Dockerfile consumer

- **WHEN** `docker compose build searxng` (equivalently `docker build services/searxng`) is run
- **THEN** the build completes successfully, exercising the `settings.yml` consumer (the Dockerfile `COPY` and the `google_sorry_fix.py` patch step) *(runtime scenario — QA/acceptance-owned)*

## Tasks

- [ ] In `services/searxng/settings.yml`, replace the scalar `use_default_settings: true` (line 1) with the `use_default_settings.engines.keep_only` mapping listing the seven engines (Edit 1). Leave the local `engines:` list unchanged.
- [ ] In `services/searxng/settings.yml`, replace the blanket-zero `suspended_times` / `ban_time_on_fail` / `max_ban_time_on_fail` block (lines 15–24) with the bounded, commented values in Edit 2. Do not touch the `outgoing:` block.
- [ ] Verify the preservation constraints by inspection: `outgoing.proxies` block unchanged; `proxies:` and `PROXY_URL}` each occur once and after the `suspended_times` block; `outgoing.retries: 3` unchanged; `google_sorry_fix.py` and the Dockerfile unchanged.
- [ ] Add `services/searxng/settings.test.mjs`: a dependency-free Node ≥ 24 test (`node --test`) that reads `settings.yml` as text and asserts every static scenario above (keep_only set equality, forbidden engines absent, six `suspended_times` keys positive and < 86400, the `Captcha < TooManyRequests < AccessDenied` ordering, `ban_time_on_fail > 0` and `max_ban_time_on_fail >= ban_time_on_fail`, comment presence, and the single-occurrence/position invariants for `proxies:` / `PROXY_URL}`). No new dependency and no container — parse the known shape with a minimal targeted reader, since Node has no built-in YAML.
- [ ] Wire the test into the root `package.json`: add `"test:searxng": "node --test services/searxng/settings.test.mjs"` and append ` && pnpm run test:searxng` to the `test` script. If the sibling story `search-client-fanout-and-timeout-budget` has already restructured the root `test` script, extend its structure rather than reverting it (see Coordination).
- [ ] **Validation (coder):** run `pnpm test` (the new `test:searxng` runs green), `pnpm build`, and `pnpm typecheck`.
- [ ] **Validation through the changed file's consumer (QA/acceptance-owned, not the coder's automated suite; requires container runtime + network):** `docker compose build searxng`; start `searxng`+`redis` with `PROXY_URL` unset and confirm `Proxy: disabled` and a clean boot; `GET /config` reports exactly the seven engines; a live search returns > 0 results. These close the runtime scenarios.
- [ ] **Documentation (writer docs pass, not the coder):** record the chosen engine set and suspension policy with rationale in `docs/ARCHITECTURE.md` under the SearXNG section, and remove this spec once its durable content is folded in.
