# Agent Pipeline Improvements

Concrete proposals for improving the agent workflow used in this repository.

Add an entry only when a specific pipeline, agent, or skill improvement is discovered. Check for an existing equivalent entry first. Product and implementation work does not belong here.

### Verify spec claims about base-image/vendored code against the actual image

**Area:** flow

**Observed:** The `searxng-engine-set-and-suspension-policy` spec asserted as fact that `google_sorry_fix.py`'s CAPTCHA path "raise[s] `SearxEngineCaptchaException(suspended_time=0)` ... EXPLICITLY" and called this "guaranteed in code (explicit argument)". The coder copied that claim verbatim into a shipped operator comment in `settings.yml`. QA runtime inspection of the built image showed it is false: the patched `google.py` raises a **bare** `SearxEngineCaptchaException()`, which per `exceptions.py` resolves to the config default (60s), so Google's /sorry/ path does not self-suspend for 0s. The spec's own scenario flagged this as "covered by inspection ... lives in the upstream image," yet asserted the inspection's conclusion without running it, and neither the spec-readiness gate nor the coder had a container to catch it. Separately, the spec instructed "leave the local `engines:` list unchanged" without knowing the current `searxng/searxng:latest` marks the `google` engine `inactive: true`, so the shipped config silently activates 6 of the 7 intended engines.

**Suggested change:** When a spec makes a definitive claim about the behavior of base-image or vendored code (exception arguments, default merges, engine activation), the author should either verify it against the actual image/source or mark it explicitly as an unverified assumption for QA to confirm at runtime — never state the conclusion of an inspection that has not been performed. Runtime-dependent deliverable facts (e.g. "the active engine set is exactly these seven") should be treated as QA-gated, not assumed from the config text.
