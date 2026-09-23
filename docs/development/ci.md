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
(diff whitespace and local inline links). AGENTS, skills, harness/CI instructions, rules and
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

## Observed rollout timings (2026-09-22 UTC)

Measurements use Actions `created_at`, `started_at`, `completed_at`, step timestamps
and cache restore logs. The [structured observations](ci-measurements.json) retain
full candidate SHAs, run/attempt/job IDs and step durations. Queue is job creation
to start; job duration is start to completion. Neither includes an unobserved workflow
concurrency wait before job creation. Setup includes install where indicated.

| Sample                                                                                                              | OS      | Job seconds | Queue seconds | Setup + install seconds | Verify step seconds | Dependency cache           |
| ------------------------------------------------------------------------------------------------------------------- | ------- | ----------: | ------------: | ----------------------: | ------------------: | -------------------------- |
| Before, main [35740738309](https://github.com/apaapapapapa/FantasySimulation/actions/runs/35740738309), attempt 1   | Linux   |          31 |             3 |                   9 + 4 |                  10 | hit (setup-vp legacy key)  |
| Before, same run                                                                                                    | Windows |          67 |             4 |                  33 + 6 |                  13 | hit (setup-vp legacy key)  |
| After, full PR [35742066714](https://github.com/apaapapapapa/FantasySimulation/actions/runs/35742066714), attempt 1 | Linux   |          27 |             2 |             12 combined |                  10 | miss (new exact store key) |
| After, same run                                                                                                     | Windows |          61 |             3 |             33 combined |                  13 | miss (new exact store key) |

The two Verify jobs total 1.63 versus 1.47 elapsed runner minutes. All executed jobs
in those runs total 11.45 versus 5.23 elapsed runner minutes (sum of job durations,
not billing multipliers or wall time). The first is main with Release; the second
is a PR with Release intentionally skipped, and runner/setup conditions and source
also differ. These are observations, not a claimed causal speedup. Verification
itself remained 10/13 seconds in these samples; no test sharding is justified.

The wording-only probe [35739277072](https://github.com/apaapapapapa/FantasySimulation/actions/runs/35739277072)
used both docs platforms. Attempt 1's Linux job took 14 seconds (queue 3 seconds),
while Windows was cancelled after 306 seconds. Its gate failed as required.
Attempt 2's Windows rerun succeeded in 45 seconds (queue 2 seconds), followed by a
successful aggregate. GitHub carries previous successful jobs into rerun views;
the mixed view must not be used to infer a negative queue or an eight-minute runner
queue. These retries are excluded from the comparable runner sums above. No pnpm
store is used by the lightweight docs jobs. The test-only PR #27 was closed unmerged.

Future measurements should compare repeated like-for-like main/source and docs
runs, retain exact attempts, and distinguish cache hit/miss/unknown. Existing receipts
support that analysis without adding task-result caching. The observations above predate the Linux-only policy.
