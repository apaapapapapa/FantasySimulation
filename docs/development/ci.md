# CI plans and evidence

## Scope

CI runs on Linux only. `scripts/ci/plan.ts` binds the plan to the tested SHA and
compares a PR merge's actual first parent. Renames count as deletion plus addition.

PRs use a fast lane (owner decision 2026-09-26, about one minute): static checks, six test
shards, build, corpus, secret scan, dependency audit/policy and the gate. Wording-only PRs add
Docs and skip Verify; PRs confined to `apps/web/src` TS/TSX/CSS or `apps/web/index.html`
skip the corpus binding. Main, manual and weekly runs add `UI (Linux Chromium/WebKit)`
([browser evidence](e2e.md)), CodeQL and paired load before release.

AGENTS, skills, harness/CI instructions, rules and ADRs are sensitive, not wording-only.
Docs checks whitespace, local inline links and repository-wide context budgets.
CodeQL recomputes the plan; its wording or fast-lane exclusion receipt must match the
common plan/source/run/attempt.
Manual runs require a full baseline SHA; scheduled comparisons use the previous main commit.

## Execution and evidence

Source tasks and the corpus never wait for the plan. `Source (static)` extracts
non-test/build/load commands from the canonical `verify` script; unsupported shell syntax
fails closed. Test-file inventory uses Vitest's own include/exclude configuration.
Receipts bind source/working-tree identity, run, attempt, shard, exit status and hashes.
Missing/extra/duplicate files, skipped assertions and altered results are rejected.

`Corpus (ubuntu-latest)` checks engine/input identity and executes every fixed input twice,
comparing all digests. `verify.ts aggregate` binds it (same source, run, attempt and corpus
bytes) to those test receipts. Verify and ci-gate each run the aggregate; release, delivery
and Issue completion require Verify. Local `vp run verify` is unchanged.

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

An exact hit on main's `node_modules` (saved right after its frozen install) skips
installation; paired load restores the pnpm store for its baseline install. Playwright
browsers are keyed separately. Keys include OS/architecture, Node, package manager,
manifests, lock and setup policy. No broad restore keys; only main populates caches.
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
