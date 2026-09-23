# CI plans and evidence

Issue #6 adapts HiFiScout `36aaf69d3f7a61195af4e85a468514dfbb1ecc80`:
`.github/actions/change-scope/action.yml` and `.github/workflows/ci.yml`.
The NUL-safe conservative comparison and explicit fan-in policy are retained; catalog/D1
jobs, four-way sharding, automatic formatting and production deployment are not copied.

The CI plan is bound to the exact tested checkout. PRs compare the synthetic merge's
actual first parent; renames are inspected as deletion plus addition. Unknown/empty
diffs, shared source, configuration, manifests, sensitive documents and scripts run
all checks. Only wording documents use the lightweight Docs job, which checks whitespace,
local inline links and repository-wide context budgets. AGENTS, skills, harness/CI
instructions, rules and ADRs are not wording-only. PR changes confined
to `apps/web/src` TS/TSX/CSS and `apps/web/index.html` (plus wording documents) run
static checks, all tests, builds and security, while excluding engine corpus/load.
Main, manual and weekly scheduled CI always run every verification group. Scheduled
comparisons use the exact previous main commit; manual runs require a baseline SHA.

## Shared execution and shards

`Source (static)` executes the existing non-test/build/load commands extracted from
`package.json`'s canonical `verify`; unrecognized shell syntax fails closed. The local
`vp run verify` and clean source harness remain unchanged. CI additionally runs
`Source (build)` and three `Source (tests-N)` jobs in parallel on Linux.
The test inventory comes from the same include/exclude patterns as Vitest. JSON
results bind content hashes, source/working-tree identity, run, attempt, shard and
exit status. Missing files, duplicated shards, skipped assertions or altered results
are rejected. Results are shared within that exact run, never cached as a future pass.

`Corpus (ubuntu-latest)` consumes those test receipts instead of rerunning mapped
files. It still executes each fixed input twice independently and verifies all input,
contract, result, event, trajectory, TS state and physics digests. `Verify (ubuntu-latest)`
collects successful task receipts and the complete test-file inventory. Its command
receipt explicitly records `node scripts/ci/verify.ts aggregate`, not a fictitious
execution of the serial local verify command. Issue completion validates the same tasks.

Three `Paired load (ubuntu-latest, N/3)` jobs partition sorted fixed case IDs. Every
case keeps five alternating baseline/candidate measurements and all warmups on one
physical runner. Different cases may use different runners; raw identities are never
combined into a fictitious common runner. The gate validates every raw sample, probe,
command, hash and current run/attempt before comparing the complete deterministic
cost profile. Profile/runtime transitions still require the shared independent corpus
boundary and exact reviewed cost digests. The candidate side also supplies the normal
CI load-budget proof, avoiding a second standalone measurement of identical cases.

`ci-gate` requires the exact planned job outcomes and source/head/base identities.
Cancelled, missing, failing or unexpectedly skipped work blocks release and delivery.
CodeQL is excluded only for verified wording-only PRs; its job recomputes the exact
scope and emits a distinct receipt, which the security adapter checks against the
common plan. Code changes retain CodeQL; secret scanning and dependency auditing run
for all PRs. No paid runner or branch-protection change is required.

The setup action caches only pnpm's content store. Candidate and baseline frozen
installs share that store while retaining their own pinned runtimes and lockfiles.
Keys include OS/architecture, Node, package manager, manifests, lock and setup policy;
TypeScript/lint configuration changes alone no longer invalidate dependency downloads.
No broad restore keys or cached test passes; PRs cannot populate main's cache.
Setup receipts retain observed cache hits and intervals. Compare equivalent PR/main
runs and distinguish cold cache, queue time and runner variability from actual work.

## Required checks and rollout

Keep the existing Linux Verify check name. Configure `ci-gate` as the stable required check when
adopting docs-only PRs: individual Verify checks deliberately skip in that plan. Keep
security checks independently required. Workflow code does not change branch protection
or bypass required reviews. Repository administrator settings must be separately verified;
without administration access their application is **unconfirmed**, not completed.

PR jobs use read-only permissions except the already scoped security-result registration;
no production credentials are supplied. Plan/source artifacts are data only; no artifact
scripts or PR build products execute in the release job. Artifacts expire after seven days.

Local focused tests: `vp test run scripts/ci` and `vp run security:test`. Finish with
canonical verify and a clean committed source harness. Workflow artifacts retain raw
results and source commands; stale-source and missing-shard regressions are required.

The owner requested Linux-only verification on 2026-09-23. Docs and toolchain policy
also run only on Linux. Windows jobs and receipts are no longer required; historical
receipts below describe the earlier policy. Security, frozen installs, strict source
checks, fixed battle inputs, regression budgets and release gates remain mandatory.

## Parallel load rollout (2026-09-23)

Before the change, main run [35806010160](https://github.com/apaapapapapa/FantasySimulation/actions/runs/35806010160)
took 392 seconds from creation to completion. Its Linux Verify job took 322 seconds:
154 seconds for source verification and 149 seconds for the subsequent paired-load
step. Windows Verify took 299 seconds. Main run
[35803891198](https://github.com/apaapapapapa/FantasySimulation/actions/runs/35803891198)
took 538 seconds, with Linux Verify at 325 seconds and Windows Verify at 440 seconds.
These observations identify the critical path; they are not controlled benchmarks.
The new graph removes the Windows jobs and overlaps source and paired-load work on
separate runners. Paired baseline/candidate trials still share one runner, alternate
in sequence, and keep the same five samples, warmups and acceptance criteria.

## Earlier observations

[ci-measurements.json](ci-measurements.json) retains the pre-Linux-only rollout's
SHAs, attempts, job/step timings and cache observations. These are historical,
uncontrolled samples, not proof of current performance. Compare repeated like-for-like
runs; distinguish queue/setup/check intervals and cache hit/miss/unknown.
