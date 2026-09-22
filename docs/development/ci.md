# CI plans and evidence

Issue #6 adapts HiFiScout `36aaf69d3f7a61195af4e85a468514dfbb1ecc80`:
`.github/actions/change-scope/action.yml` and `.github/workflows/ci.yml`.
The NUL-safe conservative comparison and explicit fan-in policy are retained; catalog/D1
jobs, four-way sharding, automatic formatting and production deployment are not copied.

The CI plan is bound to the tested checkout. A PR uses the synthetic merge's actual first
parent, not a potentially old event base. Renames are inspected as deletion plus addition.
An unknown comparison, empty diff, configuration/source change or sensitive documentation
runs both existing `Verify (ubuntu-latest)` and `Verify (windows-latest)` jobs. Main push and
manual runs always do so. Only known nonempty wording-only PRs run lightweight docs checks
(diff whitespace and local inline links). AGENTS, skills, harness/CI instructions, rules and
ADRs are not wording-only. The existing Security workflow still runs for Markdown changes.

`ci-gate` always assesses the planned jobs and actual source reports. Both OS reports must
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

Keep existing Verify check names. Configure `ci-gate` as the stable required check when
adopting docs-only PRs: individual Verify checks deliberately skip in that plan. Keep
security checks independently required. Workflow code does not change branch protection
or bypass required reviews. Repository administrator settings must be separately verified;
without administration access their application is **unconfirmed**, not completed.

PR jobs use read-only permissions except the already scoped security-result registration;
no production credentials are supplied. Plan/source artifacts are data only; no artifact
scripts or PR build products execute in the release job. Artifacts expire after seven days.

Local tests: `vp test run scripts/ci`. Source/config changes use the source harness. A future
split of expensive tests requires measured runner time and coverage. CI overhead may initially
rise for source changes because planning and evidence gating add safety checks; no speed
improvement is claimed without data.

The lightweight docs plan also runs on both Linux and Windows. The aggregate requires both
`ci-evidence:docs-ubuntu-latest` and `ci-evidence:docs-windows-latest`; one successful
platform cannot substitute for the other. Dependency policy is a required report item.
