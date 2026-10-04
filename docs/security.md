# Security checks (H4 / Issue #8)

## Scope and provenance

Development-only Node/pnpm/Vite+ checks; no production credentials or release replacement.
Design provenance: HiFiScout `36aaf69d3f7a61195af4e85a468514dfbb1ecc80`
(`secret-scan.yml`, `codeql.yml`, `renovate.json5`). No runtime code, ignores,
Markdown exclusions, old Actions pins or automerge policy were copied.

## Verified braces backport

Owner-approved on 2026-10-04: `GHSA-vfj7-8cjw-p6xm` alone may receive
`VERIFIED_BRACES_RECURSION_PATCH`. Raw High counts remain in audit receipts;
`verifiedBraces: 1` and `blocking: 0` require the exact advisory, version and eight
dependency routes, frozen wanted/installed locks, SHA-256 checks of the patch,
all reachable braces runtime files and the regression file, and seven executed,
passing, unskipped regressions. Missing or changed evidence cannot pass.
The MIT backport is from proposed upstream PR 72, commit
`28d440b5dd449dbf1fe6f3506cf94ecca4d02660`; it is not an official fixed release.
Other High/Critical findings still block. Changed scope or an available upstream
fix ends recognition; replace the backport with the official fix after review.
Changing pinned bytes/routes/tests requires explicit policy review.

## Secret scan

Every PR (including wording-only changes) and main CI calls `security.yml` for mandatory
secret scans and audits. PR CodeQL analysis is skipped: an independently computed plan
records `WORDING_ONLY_NO_CODE_CHANGE` or `PR_FAST_LANE_CODEQL_ON_MAIN` with a skip count,
accepted only for the identical plan/source/run/attempt. Main, manual and weekly
scheduled runs retain CodeQL before release.
It scans the full fetched Git history and the current working tree, including
merge-resolution changes. `fetch-depth: 0` is mandatory. Remote refs not fetched
by the checkout and inaccessible GitHub PR refs are outside that history scope.

Gitleaks 8.30.1 uses a pinned SHA-256 checksum and standard rules. Temporary synthetic
canaries test Markdown, provider rules, ignored inline annotations, clean trees and
deleted historical credentials. No real credential is used. `.gitleaksignore` and
inline `gitleaks:allow` bypasses are disabled.

Run with the pinned project Node and Gitleaks on PATH:

```sh
vp run security:test
node scripts/security/secrets.ts --self-test
vp run security:secrets
```

`security:test` also runs as part of `vp run verify` and Linux CI.
The real Gitleaks binary scan is a separate Linux job, not an offline unit test.
Missing executables, incomplete history, scanner errors, missing or invalid
reports and disagreeing exit codes are `unknown` (exit 2), never `pass`.
Detected, unexcepted secrets are `fail` (exit 1); only verified success exits 0.

## Detection output and exceptions

Captured stdout/stderr and temporary raw reports are never forwarded or uploaded;
raw reports are deleted. Public output contains only rule ID, line number and
SHA-256 location/fingerprint. Never publish credentials, raw reports or source lines.
Investigate privately; revoke/rotate genuine credentials before removal and exposure
review. Current-file deletion does not remove historical findings.

`.github/security/secret-exceptions.json` starts empty. An exception requires
exactly one `fingerprintSha256`, a meaningful `reason`, a GitHub `reviewer`,
`reviewedAt` and `expiresAt` in ISO date-time format. The maximum interval is
30 days; expiry, duplicate IDs or invalid review metadata fail the check.
There is no directory-wide, rule-wide or automatic exception mechanism.
The reviewer field is an audit record, not proof of a GitHub approval: require
an independent human review of the exception PR and do not self-approve it.

## Common evidence and the mandatory CI gate

H4's sanitized receipts retain the `fantasy-security-h4` producer. They are
inputs, not substitutes for the H1 common report. `scripts/security/evidence.ts`
converts them to that schema using the existing report assessor. The aggregate
`scripts/ci/gate.ts` requires every check below, on full and wording-only PRs.
Each entry maps the common check ID to its artifact prefix and receipt filename:

- `security:secret-canary`: `security-secrets` / `secret-canary.json`.
- `security:secret-scan`: `security-secrets` / `secret-scan.json`.
- `security:codeql-severity`: `security-codeql` / `codeql-severity.json`.
- `security:dependency-audit`: `security-audit` / `dependency-audit.json`.
- `security:renovate-configuration`: `security-renovate` / `renovate-configuration.json`.
- `security:toolchain-ubuntu-latest`: `security-toolchain-ubuntu-latest` / `toolchain-policy.json`.

Artifacts end with `-<runId>-<runAttempt>`; CI downloads that attempt into separate
directories to prevent overwrites. Receipts must match tested source SHA (PR
test-merge), head, baseline, run/attempt, producer and check ID. Invalid/future
timestamps, missing/invalid counts, inconsistent success, unexpected states or
missing evidence remain incomplete; verified blocking findings fail. The adapter
never echoes detector output or arbitrary receipt errors.

The exactly pinned official Renovate validator uses `--strict`; observed outcomes
produce receipts even on failure. Skipped, cancelled or missing execution cannot pass.
The adapter requires positive canary, CodeQL rule/toolchain coverage and no blocking
findings, including the bounded braces recognition above.

`ci-gate` retains these files in its existing artifact (7 days):

- `plan.json`: the exact source/head/base and planned full or docs execution.
- `security.json`: the common H4 report, including each original receipt URI.
- `gate.json`: job outcomes, the Linux report and all required H4 checks.
- `security-evidence/`: the original sanitized receipts, grouped by artifact.

Original security artifacts last 14 days. Missing uploads/receipts, including after
setup failure, block the aggregate gate. Recover with **Re-run all jobs** to regenerate
every receipt for the new attempt. Never copy/restamp old receipts or substitute a
gate-only rerun.

## Repository protection and external acceptance

Workflow dependencies prevent the release job from proceeding after failed or
incomplete security checks. They do not independently restrict manual merges.
[Ruleset 23838688](https://github.com/apaapapapapa/FantasySimulation/rules/23838688)
was verified active for `refs/heads/main` on 2026-09-23. It requires a PR,
resolved review threads and an up-to-date branch, forbids deletion/force pushes
and has no bypass actors. The required checks are `ci-gate`,
`Security / security-gate` and `Dependency policy / dependency-policy-gate`,
each bound to GitHub Actions (integration ID `15368`). The branch API also
reports `protected: true`; legacy branch-protection fields alone do not describe
Ruleset enforcement. Recheck the live rules before delivery.

The owner chose zero required approving reviews for solo development.
Implementation and manual-update PRs require current-head self-review; it is not
independent human approval. Eligible Renovate minors use the CI automerge policy;
SHA-bound CI and resolving findings remain mandatory. Independent approval for
secret exceptions is unchanged. Windows validation and
actual fork-PR testing are outside the current acceptance scope. Fork-specific
permissions, execution approval and SARIF publication remain untested; retain
`pull_request`, minimal permissions and no project secrets for PR validation.

Hosted Renovate activity was verified on 2026-09-26 through bot-created
[Dashboard #168](https://github.com/apaapapapapa/FantasySimulation/issues/168).
App authorization and this activity check are complete; do not request them again.
This does not establish actual update-PR acceptance. See [dependency updates](dependency-updates.md).

Remaining operational acceptance for Issue #8:

1. Review actual bot update PRs under the [minor-automerge policy](dependency-updates.md).
   Verify eligible minor PRs merge only after CI, while excluded updates remain manual.
   Coupled Vite+/alias/peer/Vitest pins and lockfiles still need manual review,
   as do vulnerability-alert, Node/pnpm and physics updates.
   Run Linux verification and all security evidence; do not manufacture a
   bot-authored PR to claim acceptance. See the official
   [Renovate configuration reference](https://docs.renovatebot.com/configuration-options/).
2. On an actual Rapier/WASM update, review physics version, WASM hash, engine
   digest and deterministic fixtures. Existing engine tests passing without a
   dependency update do not prove this upgrade path.
3. Verify the first successful GitHub `schedule` event for both Security and
   Dependency policy, including each run/attempt and sanitized receipt. The weekly
   UTC crons are Monday 19:45 and 20:15 (Tuesday 04:45 and 05:15 JST). Manual
   `workflow_dispatch` success verifies the non-PR checks, not the scheduler.

The owner's [scope decision](https://github.com/apaapapapapa/FantasySimulation/issues/8#issuecomment-5782312771)
excludes actual fork-PR testing and requiring a second reviewer, without claiming
either was performed. Do not recreate those tasks. Keep #8 open until its remaining
bot/update/schedule evidence exists, then use the existing Issue-completion protocol.
