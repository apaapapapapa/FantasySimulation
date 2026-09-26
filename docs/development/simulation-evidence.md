# Simulation evidence

[Source/PR delivery](../../.github/harness/README.md) owns clean-source and review requirements.
[Original H5 introduction](https://github.com/apaapapapapa/FantasySimulation/blob/4618f3cc78942b354e1b8271f845f288cd4582c6/docs/development/simulation-evidence.md)
retains adoption history. The contracts below remain current.

## Fixed corpus

`vp run verify` runs `check:corpus` after tests. Read-only collection replaces
`.generated/harness/corpus/` and retains it with source evidence.
`packages/engine/fixtures/spatial/corpus.json` pins engine/rules/schema, PRNG/seed derivation,
physics/WASM/angle table, recipes/seeds/revision refs and input hashes, plus mapped tests/categories.
Input identity excludes only implementationDigest: a reviewed restamp preserves the corpus;
data, rules, WASM or table changes do not.

- `corpus:engine-identity`: existing engine:check.
- `corpus:tests`: same-tree/run/attempt JSON receipts from all CI test shards, bound to the
  parallel observation by the aggregate; standalone collection runs mapped existing tests via
  local Vite+/Vitest JSON, reusing assertions.
- `corpus:identity`: engine builders reconstruct every pinned input/contract.
- `corpus:repeat`: two real executions compare result/event/trajectory/TS/physics digests.
- `coverage:<category>`: all mapped tests passed. Missing/renamed/skipped required tests stay
  unknown (exit 2); failed assertions exit 1. Planned categories are optional, remain unknown
  and are not counted as covered; they do not change an otherwise successful exit code.

results.json holds corpus hash, engine identity, platform/Node, commands and both runs.
Observed digests are not expected values; owning tests retain independent expectations.
Intentional inputs/mappings require same-PR rationale/review. Never regenerate candidate
expectations to pass. Corpus correctness is not performance acceptance.

## Linux, Worker and property evidence

CI is Linux-only (owner decision 2026-09-23); historical Windows receipts imply no new guarantee.
ci-gate binds every committed corpus input and repeated digest to Linux source/toolchain/plan.
Missing/duplicate/stale/wrong-platform/incomplete or differing repeats fail.
`coverage:corpus-artifacts` tests the validator; `corpus:artifacts` validates the actual artifact.

Real Piscina tests use one/up to four Workers and reversed submissions; fewer than two usable
Workers fails coverage. Job sequences compare real disposable SQLite with an independent ownership
model. Existing integrations cover restart, replay durability and Worker failure/cancellation.
No duplicate battle implementation is introduced.

Pinned MIT fast-check 4.10.2 uses seed 20260923, ≤24 runs/operations, 30 seconds including shrinking.
Its transitive pure-rand is test-only; xorshift32-v1/actor-stream-v1 remain unchanged.
`.generated/harness/properties` receipts record source/versions, seed/path/counts, interruption,
minimal input, launch/reproduction command and applicable manifest hash/battle seed.
Discards/interruption never pass. Set FANTASY_PROPERTY_ID/SEED/PATH from the receipt and run its
command to reproduce that case; this is not full-suite evidence. Corpus raw results retain exact commands.
`packages/engine/fixtures/spatial/minimized-hp.json` is a deliberate corruption control, not a historical bug.

Fairness exchanges IDs, slots, horizontal position/facing and actor-owned streams, comparing mapped
victory/step/damage, not hashes from different manifests. Priority/enumeration tests stay separate.
Generated suite timing is not battle performance or proof of fairness.

## Deterministic budgets and paired load

`check:load` runs every fixed corpus input with one warmup/five measured runs, including precommit.
Dirty verify produces `load-verification/`, producer load-verification, sourceState working-tree;
it checks budgets but is not SHA-bound evidence. Clean verify writes `load/`; CI uses paired
candidate samples. `harness load current` and paired collection require clean committed sources.
`load-profile.json` owns reviewed operation/log/trajectory ceilings. Zero counts are measured,
never missing instruments. Zero path/candidate budgets stay strict; 6000/250-step bounds stay exact.
The initial profile allowed roughly 20–50% positive-counter headroom (small counts rounded up)
and about 2x raw trajectory bytes. These seven cases are regression budgets, not scalability promises.
The original profile reflects approved PR #57 observed-AI behavior, not new H5 engine rules.

`vp run harness load <FULL_BASELINE_SHA>` creates a disposable worktree, installs its frozen
dependencies, checks both identities and alternates five warm baseline/candidate pairs per case.
Each target uses its own pinned corpus/profile (initial introduction supplies the new profile to
baseline fixed inputs). Identical inputs/profile use the same driver. `vp exec node`/`vp install`
select each target's runtime/package manager; never silently reuse candidate pins for an older base.
Receipts include target/driver SHA/hash, input hash, implementation/WASM identity, Node, installed
pnpm marker, lock hash, CPU/OS/arch and raw metrics. Preparation/generation/shrinking are excluded;
simulation/hashing/bounded record collection are measured. Do not infer SQLite/Worker end-to-end time.

performance.json separates elapsed median/p95, CPU median and process high-water RSS from digests.
Unmeasured Windows RSS, Worker queue/persistence time are null with reasons; real Worker
compute/backpressure/heap/WASM observations are in worker-corpus/results.json. No noisy initial
wall-time/memory threshold is imposed. Preserve commands/setup logs/trials/profiles/reports together.
Missing/interrupted/failed baseline remains incomplete and cannot be waived by review.

Three Linux CI load jobs partition fixed cases against the exact planned base; each case's five
alternating pairs/warmups stay on one runner. Corpus supplies independent transition evidence
without duplicate tests. ci-gate requires every raw shard, exact run/attempt, budgets and regression
probe before deterministic aggregation; timings retain runner identity. Main/manual/scheduled CI
always includes simulation. [CI plans](ci.md) own conservative PR exclusions/source collection.
No Cloudflare, external model or production data is used.

Changed fixtures/profiles/runtime pins/deterministic costs need reviewed load-reviews.json, binding
exact base, beforeDigest/afterDigest, reviewer/reason, before/after evidence and paired/independent
comparison. This auditable artifact is not independent approval or a waiver; never auto-generate it
in CI. Initial introduction keeps measured before values because baseline can run the same inputs.
For intentional transitions each revision must complete its own pinned inputs/budgets and candidate
must pass current corpus. Exact-base independent review may accept that transition while
load:paired-comparability remains unknown: different-input timings/counts are not comparable;
new cases have no invented before values. Subsequent same-profile changes require paired comparison.
No historical runtime registry/old Golden equality is required. Never copy old numbers or regenerate
Golden results to claim compatibility.

The same assertion probe runs on both targets. Original regression: empty corpus execution lists
incorrectly passed identity/repeat. Preserve distinct source/driver identity for failing baseline and
passing candidate. Import/setup errors cannot replace reproduction. Later fixed baselines are
retained coverage, not fabricated failing-before evidence.

## Integrated persistence performance

[ADR 0011](../adr/0011-integrated-performance.md) owns the fixed-machine 1,000-battle acceptance,
Worker comparison, reproduction commands and adoption limits.
