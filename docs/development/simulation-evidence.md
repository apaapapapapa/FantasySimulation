# Simulation evidence

Read only the relevant section. Source/PR delivery is in [the harness guide](../../.github/harness/README.md).

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
- coverage categories for Linux corpus artifacts, fairness, Worker order, job outcomes,
  load/budget and regression; the adapters described below now implement the original plans.

`corpus:engine-identity` executes the existing `engine:check`. In CI, `corpus:tests`
validates same-tree/run/attempt JSON receipts from all three test shards. The standalone command executes
only the mapped existing test files through the project-local Vite+ with the Vitest JSON
reporter; it does not copy their assertions. `corpus:identity` rebuilds every fixed input
through the engine's own builders and compares it with the pinned identity and contract.
`corpus:repeat` executes each input twice through the real engine and compares result,
event, trajectory, TS state and physics digests. `coverage:<category>` passes only when
all mapped tests passed; planned categories stay `unknown` and are not counted as covered.
Missing, renamed or skipped tests are `unknown`, failures are `fail` (exit 2 and 1).

`results.json` retains the corpus file hash, engine identity, platform, Node version,
command results and both runs' digests for repeatability and baseline comparison.
When a fixed input or mapped test changes intentionally, update the corpus file in the
same reviewed PR and state why. Never regenerate it from candidate output to pass. The
recorded digests are observations, not new expected values; expected outputs remain in
the owning tests. Performance measurement is not part of this step.

## Linux corpus, Worker and properties

The owner changed CI to Linux-only on 2026-09-23. Historical cross-OS receipts remain
historical evidence; new runs do not claim Windows compatibility or cross-OS equality.
`ci-gate` validates the Linux corpus artifact against the committed corpus and source
SHA, including every fixed input and repeated result/event/trajectory/TS/physics digest.
Missing/duplicate entries, wrong platform, stale source/toolchain, incomplete reports
and differing repeats cannot pass. The `coverage:corpus-artifacts` test exercises this
validator; `corpus:artifacts` binds the actual Linux artifact to the CI plan.
The corpus test/category mapping was renamed for this policy change; fixed battle
inputs, expected outputs, budgets and engine rules are unchanged.

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
and fixed corpus run on Linux; generated-suite timing is not a battle
performance measurement.

## Deterministic budgets and paired comparisons

`vp run check:load` runs the real engine for every fixed corpus case with one warmup
and five measured runs, including before committing. Dirty-tree verification writes
`load-verification/` with producer `load-verification` and `sourceState: working-tree`;
it checks budgets but is never accepted as SHA-bound evidence. Clean `verify` writes
`load/` for local verification. In CI the paired candidate samples supply the same budget check. `harness load current` and paired
collection still require a clean committed checkout. Counts and canonical log/trajectory bytes
have reviewed per-case ceilings in `load-profile.json`; zero counters are measured
zeros, never substitutes for a missing instrument. The initial ceilings allow
roughly 20–50% headroom for most positive operation counters; tiny counts round up,
while configured 6000-step and 250-step boundaries remain exact. Trajectory ceilings allow approximately
twice the raw encoding size. Zero path/candidate counts stay strict. These are
regression budgets for these seven cases, not product scalability promises.
The initial profile follows PR #57’s approved observed-AI rules and seventh input.
Decision/knowledge events increase log counts, and swordsman/sky-mage now reaches
the game’s 6000-step draw boundary. These are reviewed main behavior, not H5
engine changes; initial budget review requires real before/after measurements
against that exact main revision.

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

Three Linux CI load jobs partition the fixed cases against the exact planned base.
Each case keeps five alternating pairs and warmups on one runner. The shared corpus
job supplies independent transition evidence without repeating its test suite.
`ci-gate` requires every raw shard, exact current run/attempt, budget and regression
probe before aggregating deterministic costs; timings retain their physical runner
identity. Main, manual and scheduled runs always include the simulation checks.
See [CI plans](ci.md) for conservative PR exclusions and source receipt collection.
No Cloudflare, external model or production data is used. New/changed fixtures, profiles, runtime pins or deterministic costs require an exact-base review in
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
