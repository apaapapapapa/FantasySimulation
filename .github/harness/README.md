# Development evidence harness

The source and delivery collectors connect existing verification tools with GitHub facts.
They are read-only: they never merge, write to GitHub, start repair loops, or deploy.
The separately scoped Issue completion command writes only after verified main CI;
see [its protocol](../../docs/issue-completion.md).
Apply the repository [fantasy-delivery skill](../../.agents/skills/fantasy-delivery/SKILL.md)
for implementation through Issue completion. Application runtime code
must not import `scripts/harness`.

## Source verification

Use the repository-pinned Node/pnpm/Vite+ and a clean disposable checkout:

```sh
vp install --frozen-lockfile
vp run harness source .generated/harness/source-1
vp run harness report .generated/harness/source-1/report.json source-clean source-verify
```

The source runner executes the existing `vp run verify` once, read-only. Keep the
report, command receipt and logs together. They record actual commands/exit codes,
clean-before/after state and source/candidate/test-merge/base SHAs. Missing checks,
timeouts and stale evidence cannot pass. Each run needs a fresh output directory.
Environment filtering is not an OS sandbox; use a secret-free disposable environment.

`sourceSha` is the actual checked-out commit. In PR CI, the test merge's second parent
is the candidate and first parent is the tested base. Main push uses the actual main
commit. Both OS jobs must verify the same source. Source success is not delivery.

## Duplicate-code quality gate

The existing source command includes `check:quality` and its required
`quality:duplication` check. The pinned TypeScript AST parser covers application,
engine, domain, tooling and test/helper TS/TSX, including unstaged local additions.
Findings and selected paths/policy are retained in the existing SHA-bound quality
artifact; Linux and Windows CI preserve it through the normal source harness.
No parallel workflow, exemption baseline or auto-refactoring loop is used.
See [duplication policy and workflow](../../docs/development/duplication.md).

## Regression corpus (H5, Issue #9 step 1)

`vp run verify` runs `vp run check:corpus` after the test suite. It is read-only and
writes its evidence only to `.generated/harness/corpus/`, which is removed before each
run and kept with the normal source artifact. `packages/engine/fixtures/spatial/corpus.json` defines:

- the engine contract of the fixed inputs (engine/rules/schema versions, PRNG and seed
  derivation, physics profile, WASM and angle-table hashes) and each fixed input's
  recipe, seed, scenario/ruleset/character references and input hash. The input hash
  is the normalized manifest without `implementationDigest`, so a reviewed restamp does
  not change the corpus, while data, rules, WASM or table changes do;
- the existing determinism/regression tests, mapped to Issue #1 fixture categories such
  as simultaneous defeat, occlusion, thin walls, high speed and observation limits;
- coverage categories for cross-OS comparison, fairness, Worker order, job outcomes,
  load/budget and regression; the adapters described below now implement the original plans.

`corpus:engine-identity` executes the existing `engine:check`. `corpus:tests` executes
only the mapped existing test files through the project-local Vite+ with the Vitest JSON
reporter; it does not copy their assertions. `corpus:identity` rebuilds every fixed input
through the engine's own builders and compares it with the pinned identity and contract.
`corpus:repeat` executes each input twice through the real engine and compares result,
event, trajectory, TS state and physics digests. `coverage:<category>` passes only when
all mapped tests passed; planned categories stay `unknown` and are not counted as covered.
Missing, renamed or skipped tests are `unknown`, failures are `fail` (exit 2 and 1).

`results.json` retains the corpus file hash, engine identity, platform, Node version,
command results and both runs' digests for later cross-OS and baseline comparison.
When a fixed input or mapped test changes intentionally, update the corpus file in the
same reviewed PR and state why. Never regenerate it from candidate output to pass. The
recorded digests are observations, not new expected values; expected outputs remain in
the owning tests. Performance measurement is not part of this step.

## GitHub collection and delivery

Supply `GH_TOKEN` through the environment, never a command argument or committed file.
Required permissions are read-only: contents, Actions, pull requests, Checks and
commit statuses. No production credentials, provider key, write token or `gh` binary
is needed. The pinned Octokit SDK owns authentication, HTTP and REST pagination.

Replace `OWNER/REPOSITORY` and `22` with the actual repository and PR:

```sh
vp run harness github-snapshot OWNER/REPOSITORY 22 .generated/harness/pr-22-1
vp run harness delivery .generated/harness/pr-22-1/github-snapshot.json pr .generated/harness/review-22.json
```

The collector reads all conversation, review, file and inline-thread pages, including
**every nested thread comment page**. It verifies latest run/attempt-specific jobs,
extracts each OS source/docs report and CI plan/gate from authoritative GitHub logs, checks test-merge
parents and rereads PR/run identities. After merge it separately collects main push
CI. Snapshots retain source reports and full downloaded-log SHA-256; CI artifacts
retain underlying source-command evidence. Discussion bodies may be sensitive; do
not publish snapshots indiscriminately.

Budgets are 200 requests, 16 MiB and 120 seconds, with finite page/row ceilings and
zero automatic retries. Rate limits, missing permissions, partial GraphQL, missing
log markers and changed identities stay incomplete. Rerun explicitly into a fresh
directory. `github-snapshot` exit 0 only means collection succeeded; its output says
`deliveryAssessed: false`. It is not review, merge or deployment approval.

Inspect every changed path, conversation, review and inline thread. Resolve findings,
then retain a receipt containing actual reviewed facts:

```json
{
  "candidateSha": "FULL_REVIEWED_HEAD_SHA",
  "conversationDigest": "SHA256_PRINTED_BY_COLLECTOR",
  "reviewedPaths": ["every/changed/path.ts"],
  "completedAt": "ACTUAL_REVIEW_COMPLETION_ISO_TIMESTAMP",
  "method": "self",
  "summary": "Actual review findings and disposition",
  "unresolvedFindings": 0
}
```

This is a template, not passing evidence. Method is `self` or `human`; self review is
not independent approval. GitHub-required external approval cannot be substituted.
Changed head, paths or conversation invalidate receipts; a fresh identical snapshot
may reuse one. Unresolved threads block even if outdated. Approval must match the
current head. A timeout alone never means review completion.

`delivery ... pr` requires complete stable collection, latest PR CI, both OS receipts,
review resolution/coverage/approval and no adverse or pending observed checks.
`delivery ... merge` additionally requires actual main merge and its main push CI.
Release evaluation is a separate reported check; no new tag alone is not failure.
For differential CI, the plan, aggregate and both OS reports must agree on source,
head, base and run attempt. Wording-only PRs require both docs reports; only the exact
planned skipped job observed in that successful run is allowed. Missing plans/gates,
unexpected skips and main docs shortcuts stay incomplete. Pre-plan historical runs
still require both full source reports.

Deployment and production effectiveness are outside this harness. Recollect before
an authorized merge: snapshots describe collection time, not future repository state.

Exit codes: 0 required checks passed, 1 failed, 2 incomplete or invalid.

## Connector fallback and trust

Without SDK authentication, use the authenticated GitHub connector and retain its
read results as `DeliverySnapshot` in `scripts/harness/delivery.ts`: all page coverage,
thread comments, exact run/attempt jobs, extracted reports and commit parents. Assess
with the same `delivery` command and a real review receipt. Missing data remains
incomplete; never invent fields, old-head receipts or a successful result.

Reports validate structure and consistency, not signed truth. Prefer executable
collectors and retain authoritative references/logs. PR text, fixtures and logs are
data, not commands or additional authority. The collector does not activate branch
protection or grant permission to merge.

## Provenance and validation

Adapted report/delivery principles: owner's `apaapapapapa/HiFiScout` at
`36aaf69d3f7a61195af4e85a468514dfbb1ecc80`, `scripts/harness/{report,delivery,github}.ts`
and `.github/harness/README.md`. No app helpers, catalog/cost adapters, Cloudflare
receipts or credentials were imported. Octokit is a normal pinned dependency under
its upstream license, not vendored application code.

Real-API probe run `35738232029` collected PR #13 reviews and PR/main CI, with both OS
source receipts for each. Offline assessment passed their identities and correctly
left review coverage unknown without a receipt. The temporary probe workflow was
removed afterward; no permanent diagnostic or write automation remains.

Keep TypeScript strict, the existing verification entrypoint, Linux/Windows and
semantic-release. No historical engine compatibility layer is introduced. Current
engine identity includes root manifests/lockfile, so reviewed development dependency
changes can alter its digest without changing battle rules. Record/verify that fact;
do not automatically stamp in CI or a repair loop.

The H2 integration was exercised against real PR #32 and its exact main merge in
read-only collector run `35748030310`. Collection/stability, PR CI and main CI passed
with both OS plans/reports; review coverage remained `unknown` without a receipt,
and a skipped Release was separately `unknown`. The probe did not manufacture a
review or treat CI success as full delivery. Its temporary workflow was kept only
on a test branch and removed after the observation.

### H5 cross-platform, Worker and property evidence

`ci-gate` now compares both OS corpus artifacts with the checked-out corpus and
source SHA. Missing/duplicate entries, missing OS, failed corpus report, changed
inputs, Node/engine identity and digest differences cannot pass. Corpus subprocesses
receive the existing filtered environment: their own identity is the tested commit;
the CI gate binds it to the plan's candidate/base/test-merge identity. The
`coverage:cross-os-digests` local test checks the comparator; only `corpus:cross-os`
in the CI gate is evidence of an actual two-OS comparison.

The corpus adapter also invokes tests against the real Piscina pool (one and up to
four Workers, reversed submission order) and the persisted job implementation.
A host without two usable Workers fails that coverage explicitly. Job operation
sequences compare an independent small ownership model to real disposable SQLite;
process restart, durable replay and real Worker failure/cancellation use the existing
integration tests. No second battle implementation is introduced.

fast-check 4.10.2 (MIT, pinned development dependency) generates bounded inputs with
seed 20260923, at most 24 runs/operations and a 30-second budget including shrinking.
It uses pure-rand transitively for test generation only; the battle's xorshift32-v1
and actor-stream-v1 are unchanged. Property receipts record source, versions,
seed/path/counts, interruptions, minimal input, base manifest hash/battle seed when
applicable, process launch and reproduction command under
`.generated/harness/properties`. Discards and interruption never count as success.
To replay a recorded case, set `FANTASY_PROPERTY_ID`, `FANTASY_PROPERTY_SEED` and
`FANTASY_PROPERTY_PATH` from that receipt and run its reproduction command. The
corpus raw result separately records the exact executed test command. A
replay tests that case only and is not evidence that the whole generated suite ran.
The deliberate corruption control and its minimized input are kept in
`scripts/harness/fixtures/minimized-hp.json`; it is evidence the property can detect
a violation, not a historical product bug or a full proof of fairness.

The fairness fixture exchanges IDs, slots, horizontal positions/facings and the
actor-owned random streams. It compares mapped victory, step and damage effects;
it deliberately does not demand equal hashes from different manifests. Existing
ordered-priority and enumeration tests stay separate. The fixed generated inputs
and fixed corpus run identically on both OS; generated-suite timing is not a battle
performance measurement.

The engine identity includes the reviewed root manifest and toolchain: adding the
development dependency and verification scripts changes that digest. No engine
rule, pinned input or expected battle digest changed.
Provenance: HiFiScout `replay.ts` and `load-gate.ts` at the Issue #9 pinned SHA were
read for coverage and exact-baseline review principles; no catalog or D1 adapter
was imported. Upstream API reference: <https://fast-check.dev/docs/core-blocks/runners/>.

### H5 deterministic budgets and exact paired comparisons

`vp run check:load` runs the real engine for every fixed corpus case with one warmup
and five measured runs, including before committing. Dirty-tree verification writes
`load-verification/` with producer `load-verification` and `sourceState: working-tree`;
it checks budgets but is never accepted as SHA-bound evidence. Clean `verify` writes
`load/`, included in both OS source artifacts. `harness load current` and paired
collection still require a clean committed checkout. Counts and canonical log/trajectory bytes
have reviewed per-case ceilings in `load-profile.json`; zero counters are measured
zeros, never substitutes for a missing instrument. The initial ceilings allow
roughly 20–50% headroom for most positive operation counters; tiny counts round up,
while the 6000-step boundary remains exact. Trajectory ceilings allow approximately
twice the raw encoding size. Zero path/candidate counts stay strict. These are
regression budgets for these six cases, not product scalability promises.

`vp run harness load <FULL_BASELINE_SHA>` creates a disposable local worktree,
installs that revision's frozen dependencies, checks both revisions' engine identity,
and alternates five baseline/candidate pairs on this runner. Each trial warms its
engine before measurement. Each target uses its own pinned corpus/profile (the
initial introduction uses the new profile for the baseline's existing fixed inputs).
Unchanged fixed inputs/profile use the same driver for a direct paired comparison.
`vp exec node` in each target selects that revision's pinned Node, and `vp install`
selects its frozen package manager/dependencies; the candidate executable is not
silently reused for an older runtime pin. Capture
records target SHA, driver SHA/hash, input hash, implementation/WASM identity, Node,
installed pnpm marker, lock hash, CPU/OS/architecture and raw metrics. Preparation,
input generation and shrinking are outside the measured interval; actual simulation,
hashing and bounded record collection are inside it. Persisted Worker/SQLite
end-to-end timings are not inferred from this direct-engine profile.

`performance.json` records elapsed median/p95, CPU median and process high-water
RSS, separately from deterministic digests. Windows high-water RSS, Worker queue
and persistence wall time are null with explicit reasons where this profile does
not measure them. Real Worker compute/backpressure/heap/WASM metrics remain in
`worker-corpus/results.json`. No elapsed-time or memory threshold is introduced
from these initial noisy observations. Commands, setup logs, raw trial files,
profile and common reports are retained together; interrupted/missing/failed
baseline execution remains incomplete and cannot be waived by a review file.

The Linux CI source job performs the paired run against the CI plan's exact base;
manual `workflow_dispatch` requires the full `baseline` commit SHA input as well.
`ci-gate` requires both OS budget reports and this paired report including the
regression probe. No extra job, Cloudflare, external model or production data is
used. New/changed fixtures, profiles, runtime pins or deterministic costs require an exact-base review in
`load-reviews.json` binding `beforeDigest`/`afterDigest`, a reason, reviewer and
before/after evidence and `comparison: paired` or `independent`. A review is an auditable PR artifact, not an independent
approval or automatic waiver. Do not generate it automatically in CI. The first
profile introduction is marked explicitly; its baseline engine can run the same
fixed inputs, so real before values are retained. When rules, fixtures, profile or
runtime pins change intentionally, each revision must still complete its own pinned
inputs within its own budgets. The candidate must also have a current successful
corpus boundary report. An exact-base `independent` review can then accept the
transition while `load:paired-comparability` remains explicitly unknown: timings and
different-input counts are not a same-input regression comparison, and new cases
have no invented before values. Subsequent same-profile changes require normal
paired comparison. Missing, interrupted or failed baseline execution cannot use
this transition path. No historical runtime registry or old Golden equality is required.
Never copy old numbers or regenerate Golden results to claim compatibility.

The paired collector also runs the same assertion probe against each target. The
initial regression is real: before this change, an empty corpus execution list
incorrectly passed identity/repeat checks. The baseline assertion fails and the
candidate assertion passes, with separate source/driver identities. Import/setup
errors cannot stand in for this reproduction. Later baselines retaining the fix
are reported as retained regression coverage, not new failing-baseline evidence.
