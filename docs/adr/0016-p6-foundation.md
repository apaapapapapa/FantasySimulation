# ADR 0016: P6 foundation

**Accepted by owner in ChatGPT, 2026-09-26.** Refs #155, #1.
P6-00 is infrastructure; mechanics/publication are separate (#155/#158).

## Admission and leagues (00c)

Optional strict `ruleset.experimental: { mechanics: MechanicId[] }`: nonempty, unique,
canonical order; omission=standard. Registry: implemented/standard-ready/experimental/
reserved. Known future permissions never enable unimplemented payloads; unknowns fail.
Instant-death/time-stop/immortality/absolute-hit/absolute-evasion/mind-read are experimental
(Q-1). Standard mechanics work in both classes; incomplete P6 interference requires opt-in.

One exhaustive closure visitor covers abilities/stages/reactions/equipment/statuses and
dormant periodic/transform/grant branches. Shared prepare/job/retry/league admission runs
before reservations/Workers. Keep version/identity gates; reject unsupported inputs with
code/mechanic/owner kind/id/revision/hash, never an unresolved/draw result.

Derive league class from pinned ruleset. Separate IDs/ranks/scores; never replace a
standard ID with experimental content. New public catalog/snapshot optional class must
match checksummed definition; old omission=standard only without experimental permissions.
Pages list/detail/ranks show 「実験」 regardless of mechanics used in that match. Manual
dry-run/publish only, no experimental schedule or required production publication (Q-2).
Saved validation/replay remains engine-free.

## Interference (00b)

Canonical `packages/domain/src/spatial/interference.json`: versioned #155 §2-B registry,
every ordered/self pair and exhaustive schema bindings. Explicit conditional predicates;
no wildcard independence or implicit symmetry.

| Cell        | Required evidence                             |
| ----------- | --------------------------------------------- |
| defined     | Rule ID/summary; independent expected fixture |
| independent | Reason neither changes the other’s state      |
| unresolved  | Rule ID; actual diagnostic regression         |
| rejected    | Admission reason; rejection fixture           |

`interference-coverage.json` binds cells to corpus test receipts outside execution identity.
`interference-baseline.json` fixes 484 pre-change pair outcomes/hashes; never regenerate
from the candidate. Validate complete cells/IDs/reasons and executed assertions.
Negative controls: missing cell/fixture, unclassified variant. Reserved mechanics reject.
Reuse current resolvers; reject prohibited closure pairs, stop unresolved on interaction.
Existing-existing unresolved semantics stay. Standard P6 requires defined/independent
behavior for every accepted existing/standard pairing; rejected subcases fail admission.
No winner by registration/ID/enumeration order.

## Unresolved context (00b)

Keep ruleId/revisions/reason; optional ruleset `interferenceDiagnostics: 'v1'` enables
new P6 diagnostics. Omission preserves legacy shape/behavior. Optional outcome.interferences:
step, point (startup/boundary/contact/before-hit/after-damage/before-defeat/status-commit),
wave, actors, causes, ability/status kind/id/revision/hash, rule ID. Null wave only outside
waves; step=attempted boundary, not future status activation.

Caps: 16 entries/result, 2 actors/entry, 32 causes/entry, 64 revision refs/entry, 32KiB context;
existing string/record budgets apply. Capture all competing causes at the failing point
before rollback, not later conflicts. Causes reference committed events or self-contained
attempts (step/point/wave/actor/ability/ordinal), never dangling rolled-back replay IDs.
Sort only for encoding. No raw objects/stacks/paths; reason <=500 characters.
Overflow yields truncated with resource/observed/limit/cause, not a partial causal set;
add budget details compatibly if needed. Preserve last committed display and rollback
costs/PRNG/IDs/hits/queues/events. Reaction caps stay 64/transaction, 1024/match, depth8;
work limits differ from uses. Fit existing terminal allocation. Worker/SQLite/result/
ReplayState validate/round-trip without engine; reject invalid bounds/references.

## Official milestones (00c)

Amend [ADR 0015](0015-league.md) only for configured official standard league scheduling.
Preserve inputHash/leagueHash/simulationHash. Separate structural normalization from
current-engine eligibility. Comparison-only definitionHash binds normalized definition/
pinned closure, budgets/seed/scoring/placements/rules, excluding source/engine identity;
never use for result-cache reuse. Validate all supplied hashes/refs before reducing closure.
Before createLeagueRevision/slot expansion/leases/reservations/writes, bounded public probe
verifies catalog/snapshot/definition hashes/sizes/cross-links. Compare historical definition
without execution or stored-byte normalization. Source SHA alone is not input change.

| Valid scheduled official input               | Outcome                          |
| -------------------------------------------- | -------------------------------- |
| Unsupported rules                            | skip: rules-milestone-required   |
| Same definition, changed identity            | skip: engine-milestone-required  |
| Same definition/identity                     | Existing completion/retry policy |
| New supported definition / first publication | Existing estimate/admission      |

Skip means needed=false, exit0.

Invalid data/hash/link, missing child, network/auth/budget errors retain typed failures.
Only initial pointer 404 means first publication. Partial snapshots also hold on changed
engine/rules, preserving unresolved denominators. Recovery may reuse original verified
artifacts (#158), never old execution. Changed definitions with old rules also hold.
Bounded receipt/Actions summary records reason/definition/identities; no production keys,
R2 writes/reservations on holds. Manual dry-run reports comparison/estimate if executable;
manual publish rejects unchanged-definition identity-only changes and unsupported rules.

Groups 1/2 add official definition/rules IDs with the same 20 participants (Q-13).
Bind dry-run/publish to tested source/definition/catalog; re-estimate drift. Record
planned/reused/new/retry slots, requests/files/bytes/retention/time and actual writes/storage/cost.
Keep budgets, main CI, viewer, journal/leases, protected environment, serialization/conditional pointers.
Keep public bytes/ranks and list revisions separately; no milestone in P6-00.

## Acceptance and compatibility

00b: matrix, conflict diagnostics, rollback/caps, Worker/SQLite/replay and order/RNG symmetry.
00c: closure/admission, league isolation/labels, old publications, zero-work holds,
corruption/manual races, fixed scoring/seeds. See #155 §2-C for each mechanic's gates.
[Compatibility](0010-battle-version-compatibility.md)/[identity](0013-execution-identity.md):
00b/c are additive at spatial-v1.20 with reviewed restamp; legacy decisions and hashes stay
fixed except new diagnostic terminals. New ID experimental-p6-foundation-v1; published
revisions remain immutable. Delivery gates, Markdown <=170,000 bytes and #155 open remain.
