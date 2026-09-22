# CodeQL and dependency audit (H4 / Issue #8)

See [the security runbook](security.md) for secret handling, receipts, provenance
and the still-unverified repository settings. This is the second implementation
PR; it extends the existing H4 gate rather than replacing platform verification.

## CodeQL analysis and severity policy

The reusable security workflow analyzes `apps`, `packages` and `scripts`
with CodeQL v4 pinned to `1c5b675653bb5c22dbe9b12b556ec555138e09fd`.
PRs use the default JavaScript/TypeScript suite; main, manual and weekly runs
use `security-extended`. There is no Markdown-only workflow bypass.
No application build, dependency lifecycle script or production secret is
needed for CodeQL extraction. Only its job receives `security-events: write`.
The caller grants this permission to the reusable workflow; the other jobs
remain read-only. `pull_request_target` is deliberately not used.

Analysis completion, severity acceptance and publishing to GitHub code scanning
are separate steps. The local SARIF inventory blocks any security score >= 7.0
(high/critical), including unchanged baseline results and suppressed results.
No application-wide legacy baseline or automatic exception is introduced.
Missing SARIF, an unexpected producer, failed invocation, missing rule or
unusable security severity cannot pass. The policy artifact contains only
counts and source/run metadata, not raw SARIF or source snippets.
Analysis is published to GitHub even when the severity policy fails, provided
the analysis completed successfully. Upload/processing failure also fails
`security-gate`; successful analysis alone is not evidence of accepted risk.

Before closing #8, check repository Security > Code scanning: advanced setup,
main coverage, selected query suite, initial high/critical inventory and
SARIF processing must all be verified. Resolve conflicting default setup
rather than running duplicate analyses. Current platform settings and an
initial clean main inventory are **not established by merely adding YAML**.
Fork PRs use the ordinary `pull_request` event and built-in token; no PAT or
repository secret is passed. If GitHub denies publishing, record that failure
and fix the platform policy rather than allowing a missing scan to pass.

## Dependency audit

`node scripts/security/audit.ts` uses the exact pnpm `packageManager`, the
exact `.node-version` and the existing pnpm lockfile. It audits development,
production, optional and transitive dependencies; no `--prod` or `--no-optional`
filter is used. This job reads the lockfile without installing application
packages or running their lifecycle hooks. Both normal verify jobs still
perform frozen installation and the full application verification.

The JSON report and process exit code must agree. High/critical findings block;
info/low/moderate counts remain visible in the receipt. Registry errors,
truncated/invalid JSON, missing inventory, missing executable and an unexpected
exit code are `unknown`, never success. `--ignore-registry-errors` and
`--ignore-unfixable` are explicitly false; no `--fix` or `--ignore` action runs.
Repository audit exception settings are rejected until a reviewed, bounded
exception mechanism is deliberately designed. Do not resolve a failing audit
by adding broad ignores or disabling the job. No npm/package-lock migration
is introduced, and dependency manifests/lockfile must remain unchanged.

Every planned secret, CodeQL and audit job must succeed for `security-gate`.
An unexpectedly skipped job is a failure, including permission/setup failures.
Required-check configuration and integration with #5/#6 remain externally
tracked; this does not claim they have been configured.
