# CI plans and evidence

Issue #6 adapts HiFiScout `36aaf69d3f7a61195af4e85a468514dfbb1ecc80`:
`.github/actions/change-scope/action.yml` and `.github/workflows/ci.yml`.
The NUL-safe conservative comparison and explicit fan-in policy are retained; catalog/D1
jobs, four-way sharding, automatic formatting and production deployment are not copied.

The CI plan is bound to the tested checkout. A PR uses the synthetic merge's actual first
parent, not a potentially old event base. Renames are inspected as deletion plus addition.
An unknown comparison, empty diff, configuration/source change or sensitive documentation
runs `Verify (ubuntu-latest)` and `Paired load (ubuntu-latest)` concurrently on separate
Linux runners. Main push and manual runs always do so. Only known nonempty wording-only PRs run lightweight docs checks
(diff whitespace, local inline links and repository-wide context budgets). AGENTS, skills, harness/CI instructions, rules and
ADRs are not wording-only. The existing Security workflow still runs for Markdown changes.

`ci-gate` always assesses the planned jobs and actual source reports. The Linux source and paired-load reports must
exist and match the planned source/head/base. Missing, cancelled, failing or unexpected
skipped work blocks the gate. Release requires full verification, Security and this gate on
main. The source collector continues to execute the unchanged `vp run verify` entrypoint.

The setup action caches only the pnpm content store, never node_modules, app artifacts,
verification results, replay or physics state. Keys include OS/architecture and exact Node,
package-manager, lockfile, workspace manifests and configuration identity. No broad restore
keys; PRs cannot save into main's cache. Frozen install is mandatory. Setup receipts record
cache hit (null when unknown), source/run/attempt, runtime/OS and start/end timestamps.
Source receipts record verification intervals. Use Actions job data for queue/setup/job
durations; missing historical cache observations remain unknown. Do not infer a speedup or
runtime regression from an unrelated runner's single sample.

## Required checks and rollout

Keep the existing Linux Verify check name. Configure `ci-gate` as the stable required check when
adopting docs-only PRs: individual Verify checks deliberately skip in that plan. Keep
security checks independently required. Workflow code does not change branch protection
or bypass required reviews. Repository administrator settings must be separately verified;
without administration access their application is **unconfirmed**, not completed.

PR jobs use read-only permissions except the already scoped security-result registration;
no production credentials are supplied. Plan/source artifacts are data only; no artifact
scripts or PR build products execute in the release job. Artifacts expire after seven days.

Local tests: `vp test run scripts/ci`. Source/config changes use the source harness. The canonical source verification is unchanged. The paired-load job additionally runs
the existing corpus boundary checks, retaining evidence for profile/toolchain transitions.
It uploads a separate artifact; `ci-gate` requires its successful job and exact-source/base
raw trials before release or delivery can pass.

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
