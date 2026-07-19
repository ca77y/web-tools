# Issues

Investigated production problems for which **no fix could be identified inside this repository** — typically because the root cause is upstream, third-party, commercial, or the evidence needed to diagnose it was not recoverable.

An issue note is not a story. It is the durable record of an investigation that concluded without an actionable change, so the same ground is not re-covered later.

## Rules

- One file per issue, `<slug>.md`, lowercase kebab-case.
- State the problem, the evidence (with verbatim logs, counts, and `file:line` references), what was investigated, and **why no solution could be identified**.
- Be self-contained. Inline the evidence rather than pointing at temporary files.
- Link any related stories in `../tasks/` that reduce the symptom without fixing the cause, and say plainly which is which.
- When a fix does become identifiable, raise a story in `../tasks/` and link it here.
