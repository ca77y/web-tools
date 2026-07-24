# SearXNG local engine expansion — working notes

In-flight notes for expanding the working engine set of the **local** deployment.
Removed once durable findings are folded into `docs/ARCHITECTURE.md` / the board.

## Baseline (measured 2026-07-24, local stack, residential IP, sequential probes)

| Engine | Score | Notes |
|---|---|---|
| google cse | 3/3, 20r | best performer |
| bing | 3/3, 10r | most reliable |
| brave | 1/3, 20r | one query cold, then `too many requests` suspension |
| duckduckgo | 2/3, 10r | ~2 queries, then CAPTCHA |
| qwant | 0/3 | CAPTCHA every attempt |
| mojeek | 0/3 | `access denied` |
| wikipedia | 0/3 | infobox-only by design; never contributes `results` |

Default aggregate: 30–39 results/query, effectively from `google cse` + `bing` (+ `brave` bursts).

## Plan

1. [x] Baseline measured (above)
2. [x] Online research: fixes for qwant/mojeek/ddg/brave; strong new engine candidates
3. [x] Enumerate candidate engines available in the image
4. [x] Probe candidates from a stock container (isolated from prod config)
5. [x] Adopt winners into `settings.yml` + tests + docs
6. [x] Re-measure aggregate, run full test suite

## Research findings

- **Image is fresh** — `searxng/searxng:latest` = `2026.7.22+ef8f6470e`, built 2026-07-22. No staleness angle.
- **qwant: unfixable at config level.** Uses Datadome bot protection ([searxng#3929](https://github.com/searxng/searxng/issues/3929), open). Every community fix (datadome-cookie injection, curl_cffi TLS impersonation) gets counter-adapted "within 2 days". Maintainer: "qwant can be removed as an engine from my point of view."
- **mojeek: IP-scoped CAPTCHA, partially recoverable.** ([searxng#4307](https://github.com/searxng/searxng/issues/4307), open). The `fmt=` param bug was fixed in #4354; remaining blocks are per-IP. Upstream suggests [answer-CAPTCHA-from-server's-IP](https://docs.searxng.org/admin/answer-captcha.html) — viable locally since egress = our own residential IP: visit mojeek.com in a browser, solve the challenge, restart searxng to clear suspension.
- **Upstream consensus on majors** ([discussion#5651](https://github.com/searxng/searxng/discussions/5651)): Google down (JS-gated), Brave rate-limits, DDG CAPTCHAs — matches our baseline exactly. Not a local misconfiguration.
- **Candidate engines present in the image** (active code, `disabled: true` only — still queryable via explicit `engines=`): `startpage` (Google-backed, **enabled by default upstream**), `yahoo` (Bing-backed, separate quota path), `presearch`, `yep`, `dogpile` (Google+Yahoo meta), `duckduckgo web` (different DDG endpoint), `yandex`, `infospace`/`searchtoday` (s1search meta), `gmx`, `wiby`/`mwmbl`/`marginalia` (niche small-web).

## Candidate probe results

Stock container (`searxng/searxng:latest` 2026.7.22), same residential IP, 3 sequential queries each:

| Engine | Score | Results/query | Note |
|---|---|---|---|
| yep | 3/3 | 20 | |
| presearch | 3/3 | 10 | |
| duckduckgo web | 3/3 | 10 | different endpoint than our failing `duckduckgo` |
| yandex | 3/3 | 10 | |
| **mojeek** | **3/3** | 9–10 | works on stock config — see root cause below |
| gmx | 3/3 | 10 | |
| dogpile | 3/3 | 8 | Google+Yahoo metasearch |
| infospace | 3/3 | 8 | |
| startpage | 0/3 | — | instant CAPTCHA; dead |
| yahoo | 0/3 | — | HTTP protocol error; dead |

## Root cause: `default_lang: en` breaks mojeek

Our stack: mojeek 0/3. Stock probe, same IP, same hour: 3/3. Single-variable
tests on the stock container (one config delta per run, 2 queries each):

| Variant | mojeek |
|---|---|
| stock + `enable_http2: false` | 9r, 10r — fine |
| stock + `verify: false` | 9r, 10r — fine |
| stock + `default_lang: en` | **0r, 0r — silent empty** |

Mechanism: `mojeek.py` sends locale as cookies (`lb`, `arc`). Locale `en` →
`lb=en; arc=us`; locale `auto` → `lb=; arc=none`. The `lb=en; arc=us` cookie
pair triggers mojeek's bot detection (0 results / 403), matching upstream
[#4307](https://github.com/searxng/searxng/issues/4307) where region params
tripped "automated tools detection". Fix: `default_lang: auto`.

Note: this also invalidates yesterday's "mojeek fails from production because
of datacenter IP" line in the proxy story — it fails from *any* IP with our
config. The proxy story's evidence table needs re-measuring after this fix.

## Changes made

All in `services/searxng/settings.yml` (+ tests, + docs):

1. **`default_lang: en` → `auto`** — fixes mojeek (root cause above), with an
   in-file comment and a structural test guarding the rationale.
2. **Allowlist revised, 7 → 9 engines.**
   - Removed: `qwant` (Datadome, dead from every IP), `duckduckgo` (lite-page
     scraper, CAPTCHA after ~2 queries).
   - Added: `duckduckgo web` (d.js JSON API, 6/6), `yandex` (distinct index,
     6/6), `dogpile` (Google+Yahoo meta, 6/6), `gmx` (Google-backed, 6/6).
   - Kept: `google cse`, `bing`, `brave`, `mojeek` (now working), `wikipedia`
     (infobox-only, documented as such).
   - Rejected after probing: `startpage` (instant CAPTCHA), `yahoo` (protocol
     error), `presearch` (timeouts), `yep` (junk quality), `infospace`
     (redundant with dogpile).
3. **Tests** (`settings.test.mjs`): new 9-engine expectation; `qwant` and
   `duckduckgo` added to the forbidden list (checked in both `keep_only` and
   `engines:`); new `default_lang: auto` + mojeek-trap test. 19/19 pass;
   full suite 363/363.
4. **Docs**: ARCHITECTURE gained "The 2026-07-24 engine-set revision";
   the egress-proxy story card gained a dated correction (its mojeek/qwant
   evidence rows were superseded — mojeek was config, qwant is universal).

## Result (measured through the rebuilt local stack)

| Engine | Score | Results/query |
|---|---|---|
| google cse | 3/3 | 20 |
| bing | 3/3 | 10 |
| duckduckgo web | 3/3 | 10 |
| mojeek | 3/3 | 9–10 |
| yandex | 3/3 | 10 |
| dogpile | 3/3 | 8 |
| gmx | 2/3 | 10 (one parsing error, loudly recorded) |
| brave | 0/3 → bursts | rate-limited from today's probing; recovered in aggregate run 2 |

Default aggregate: **53–61 results from 7–8 engines** (was 30–39 from 2–3).
E2E `web_search` through the toolkit API verified.

## Follow-ups

- Deploy: these gains are local-config wins and travel with `settings.yml`,
  but production is still expected to lose most engines to the unproxied
  datacenter egress — `docs/tasks/searxng-configure-egress-proxy.md`.
- `brave` is IP-rate-limited (~1 query per cooldown window); nothing
  config-level found; suspension policy already bounds it.
- If mojeek 403s reappear locally: solve its browser CAPTCHA from this IP
  (answer-captcha-from-server's-IP), then restart searxng.
