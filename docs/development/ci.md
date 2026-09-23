# CI plans and evidence

## Scope

CI runs on Linux only. `scripts/ci/plan.ts` binds the plan to the tested SHA and
compares a PR merge's actual first parent. Renames count as deletion plus addition.

- Known nonempty wording-only PRs run Docs, secret scan, dependency audit/policy and the gate.
- PRs confined to `apps/web/src` TS/TSX/CSS or `apps/web/index.html`, plus wording,
  run static checks, all tests, build, security/policy and the gate.
- Other/unknown/empty diffs, main, manual and weekly runs include corpus and paired load too.

Full plans also require `UI (Linux Chromium)` with its isolated local API/SQLite and
browser evidence. Wording-only PRs explicitly skip it. See [browser evidence](e2e.md).

AGENTS, skills, harness/CI instructions, rules and ADRs are sensitive, not wording-only.
Docs checks whitespace, local inline links and repository-wide context budgets.
CodeQL independently recomputes wording scope; its distinct exclusion receipt must
match the common plan/source/run/attempt. Code changes retain CodeQL.
Manual runs require a full baseline SHA; scheduled comparisons use the previous main commit.

## Execution and evidence

`Source (static)` extracts non-test/build/load commands from the canonical `verify`
script; unsupported shell syntax fails closed. Build and three test shards run in
parallel. Test-file inventory uses Vitest's own include/exclude configuration.
Receipts bind source/working-tree identity, run, attempt, shard, exit status and hashes.
Missing/extra/duplicate files, skipped assertions and altered results are rejected.

`Corpus (ubuntu-latest)` reuses those exact test results. It still checks engine/input
identity and executes every fixed input twice, comparing all deterministic digests.
`Verify (ubuntu-latest)` collects task outcomes, logs and complete test coverage; its
receipt truthfully records `node scripts/ci/verify.ts aggregate`. Issue completion
validates the same tasks. Local `vp run verify` and the clean source harness are unchanged.

Three load jobs partition sorted fixed case IDs. Each case keeps five alternating
baseline/candidate measurements and warmups on one physical runner. The candidate
samples also prove normal load budgets. `ci-gate` validates every raw shard, command,
probe, SHA, run/attempt and sample before combining deterministic costs; runner
identities remain distinct. Profile/runtime transitions retain independent corpus
boundary evidence and exact reviewed cost digests. See
[simulation evidence](simulation-evidence.md) for budget and comparison contracts.

Missing, cancelled, failing, stale or unexpectedly skipped work blocks delivery and
release. No successful test results are cached for future runs. Artifacts expire after
seven days; PR artifacts remain data and are never executed by release.

## Setup and gates

The pnpm content store and separately keyed Playwright browser downloads are cached.
Candidate and baseline frozen installs share the content store
while retaining their own runtime/lockfile pins. Keys include OS/architecture, Node,
package manager, manifests, lock and setup policy; lint/TypeScript config alone does
not invalidate downloads. No broad restore keys; only main populates its cache.
Setup receipts retain observed hits and intervals.

Keep `ci-gate`, Security and Dependency policy gates required. The existing Linux
Verify name remains; it deliberately skips for wording-only PRs. Workflow changes do
not alter branch protection or required reviews; verify repository settings separately.
PR jobs are read-only except scoped security-result registration; no production
credentials or paid runners are added. Main release requires every gate.

Run focused `vp test run scripts/ci` and `vp run security:test`, then canonical verify
and the clean committed source harness. See the [delivery guide](../../.github/harness/README.md).

Compare equivalent PR/main runs including queue, setup and cache observations.
[Historical measurements](ci-measurements.json) predate Linux-only CI (2026-09-23)
and do not establish current Windows compatibility or performance.
