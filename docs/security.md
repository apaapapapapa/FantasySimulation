# Security checks (H4 / Issue #8)

## Scope and provenance

These development-only checks protect the existing Node/pnpm/Vite+ workspace.
They do not install production credentials or replace semantic-release.
The design was adapted from HiFiScout commit
`36aaf69d3f7a61195af4e85a468514dfbb1ecc80`, specifically
`.github/workflows/secret-scan.yml`, `codeql.yml` and `renovate.json5`.
The implementation here is independent; no HiFiScout runtime code, ignore list,
Markdown exclusion, old Actions pin or automatic merge policy was copied.

## Secret scan

Every PR (including Markdown-only PRs) and main CI calls `security.yml`.
Only conservatively verified wording-only PRs exclude CodeQL analysis. The job independently
recomputes the exact merge diff and records `WORDING_ONLY_NO_CODE_CHANGE` with a planned-skip
count. The common gate accepts that receipt only for the identical plan/source/run/attempt.
Code, configuration, sensitive docs, uncertain diffs, main/manual/scheduled runs retain
CodeQL. Secret scans and dependency audits remain mandatory even for wording changes.
The same workflow can be started manually and runs weekly on main.
It scans the full fetched Git history and the current working tree, including
merge-resolution changes. `fetch-depth: 0` is mandatory. Remote refs not fetched
by the checkout and inaccessible GitHub PR refs are outside that history scope.

Gitleaks 8.30.1 is downloaded with a repository-pinned SHA-256 checksum.
Its standard detection rules are enabled. A synthetic canary is generated only
in a temporary directory: the test checks Markdown, default provider rules,
ignored inline annotations, a clean tree and a deleted historical credential.
No real credential is used. Repository `.gitleaksignore` and inline
`gitleaks:allow` bypasses are disabled by the runner.

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

The runner captures stdout/stderr without forwarding them. Raw detector reports
are temporary and deleted; they are never uploaded. Public output includes only
rule ID, line number, a SHA-256 location identifier and a SHA-256 fingerprint.
Do not paste a suspected credential, raw detector report or source line into
an Issue, PR, artifact or public log. Locate it in a private local investigation,
revoke/rotate a genuine credential first, then remove it and investigate exposure.
Deleting a current file does not remove the finding from its history.

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

Each artifact name ends with `-<runId>-<runAttempt>`. CI downloads only that
run and attempt and keeps artifact directories separate, so independently produced
receipts cannot overwrite each other. Receipts must match the exact tested
source SHA, PR head, baseline, run and attempt, producer and check ID. PR
source SHA remains the test-merge SHA, not the PR head. Invalid timestamps,
future completion times, missing/invalid counts, inconsistent success claims,
unexpected states and missing evidence remain incomplete. Verified findings
remain failures. No detector output or arbitrary receipt error string is echoed
by the adapter.

The official Renovate validator still runs with its existing exact pin and
`--strict`. Its observed step outcome produces a receipt even after a failure;
skipped, cancelled and missing execution never produce a passing receipt.
The adapter also verifies positive canary, required CodeQL rule and toolchain coverage
and the absence of blocking/high/critical findings where appropriate.

`ci-gate` retains these files in its existing artifact (7 days):

- `plan.json`: the exact source/head/base and planned full or docs execution.
- `security.json`: the common H4 report, including each original receipt URI.
- `gate.json`: job outcomes, the Linux report and all required H4 checks.
- `security-evidence/`: the original sanitized receipts, grouped by artifact.

The original security artifacts remain available for 14 days. Setup failure
can prevent receipt creation; missing uploads or receipt files still block the
aggregate gate. To recover a failed attempt, use **Re-run all jobs** so every
required receipt is regenerated for the new attempt. Do not copy old receipts,
restamp their identities or use a gate-only rerun as substitute evidence.

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
Current-head self-review, resolving findings and SHA-bound CI remain required;
self-review is not independent human approval. The separate independent-human
approval rule for secret exceptions above is unchanged. Windows validation and
actual fork-PR testing are outside the current acceptance scope. Fork-specific
permissions, execution approval and SARIF publication remain untested; retain
`pull_request`, minimal permissions and no project secrets for PR validation.

Remaining operational acceptance for Issue #8:

1. Verify actual hosted Renovate activity. The owner already completed App
   authorization; do not ask for it again. A valid `renovate.json` or authorization
   confirmation does not prove bot execution. See [dependency updates](dependency-updates.md).
2. Approve one suitable update from the bot's Dependency Dashboard. Confirm the real
   bot PR has automerge disabled, coupled Vite+/alias/peer/Vitest pins and the
   correct lockfile. Preserve manual review, including vulnerability updates.
   Run Linux verification and all security evidence; do not manufacture a
   bot-authored PR to claim acceptance. See the official
   [Renovate configuration reference](https://docs.renovatebot.com/configuration-options/).
3. On an actual Rapier/WASM update, review physics version, WASM hash, engine
   digest and deterministic fixtures. Existing engine tests passing without a
   dependency update do not prove this upgrade path.
4. Verify the first successful GitHub `schedule` event for both Security and
   Dependency policy, including each run/attempt and sanitized receipt. The weekly
   UTC crons are Monday 19:45 and 20:15 (Tuesday 04:45 and 05:15 JST). Manual
   `workflow_dispatch` success verifies the non-PR checks, not the scheduler.

The owner's [scope decision](https://github.com/apaapapapapa/FantasySimulation/issues/8#issuecomment-5782312771)
excludes actual fork-PR testing and requiring a second reviewer, without claiming
either was performed. Do not recreate those tasks. Keep #8 open until its remaining
bot/update/schedule evidence exists, then use the existing Issue-completion protocol.
