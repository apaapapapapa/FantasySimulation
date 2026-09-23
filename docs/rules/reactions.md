# Reactions (spatial-v1.18)

Refs #61 G-08; [approved design](../adr/0012-stages-and-reactions.md).
`standard-reactions-v1` adds optional `Ability.reaction` and three triggers.
Old definitions without reactions keep their event/resource/PRNG behavior. Published
v1.17 IDs/hashes remain readable; old execution is rejected, never converted.

## Definition and clocks

- `before-hit`: direct self effects (shield, heal, status/dispel/water), or
  `parry` with no payload and scope `all` / `damage`.
- `after-damage`: non-restorative direct self effects, or a deferred enemy
  `counter` using hitscan. Geometry, power, categories, costs and clocks are ordinary
  ability data. Positive hostile post-shield rational damage is required, before
  remaining-HP clipping or netting simultaneous healing. Costs/environment/self
  damage cannot activate it; full shield or zero damage cannot activate it.
- `before-defeat`: direct non-restorative effects on provisional HP0 owners after
  all waves. Same-wave healing already occurred. It is an extension point, not revival.

Cast is zero; explicit stages/authored movement and immediate self attacks are
rejected. Counters have no authored motion, so their separate slot can coexist with
the main action. After-damage/before-defeat healing is rejected until explicit P6
restoration. Reflection, absorption, revival, piercing/replacement and other shapes
are not accepted response definitions.

Optional category and element filters are ANDed; each list is ORed. Categories
use G-01, including its legacy MP default. Element filters match damage or water
contact. Before-defeat has no contact filters. Whole parry cancels every payload of
each matching contact, including status, force and G-03 element reactions.
Damage-only parry cancels matching damage components while retaining their original
element contact and all nondamage payload. Its damage event records zero after
modifiers/absorbed/toHp and the parry causes. An accepted contact consumes the G-07
hit ledger even if parried or reduced to zero.

At each owner/ability/point/wave there is at most one activation, regardless of the
number of matching contacts. Eligibility uses old capabilities, current provisional
resources, condition, cooldown and semantic uses. Conditions see only the owner's
delayed view; incoming mechanics are not an observation. Every eligible reaction of
one owner reserves together through G-04 ResourceBudget, then pays once; shortage
pays none. Exhausted uses disable that ability. Recovery and cooldown start at the
activation boundary; readiness is their maximum, independently of the main slot.

A counter stores its paid activation ID and depth. Boundary transaction n can
release in interval n; interval n releases no earlier than interval n+1. Release
rechecks life, incapacity/silence, condition and observed range/facing. Shared hitscan
checks muzzle, walls and the actual body; two aim draws occur only on release.
One ledger entry per counter prevents repeat contact. No second payment, future
hold or refund; defeat cancels a paid queue even when activation followed lethal
damage. Failed range/capability also retains costs.

## Atomic waves and limits

The existing 20ms coordinator owns clones and commits. Startup initialization at
zero precedes expiry, resource pulses and periodic HP, preserving the old boundary.
Boundary and interval are separate transactions; no final extra boundary pulse.
Geometry/accepted contacts and movement settle before reactions:
before-hit responses join primary damage/healing/shield; after-damage responses
follow; before-defeat follows every wave; statuses and verdict commit last.
Each wave reuses G-02 exact attribution, shared shield and a single HP clamp.
G-03 freezes old modifiers/cohorts across the whole transaction and plans the union
of accepted contacts/grants/removals once. Remove beats strengthen, conflicting
transforms are unresolved, transforms are not recursive, permanent protection holds.

Defaults/ceilings are 64 activations/transaction, 1024/match and ancestry depth8
(primary0); callers may lower these. Pending counters retain ancestry across
intervals. Empty waves add no ancestry. Queue ceiling is64/owner. Semantic
uses/cooldowns differ from work limits: an eligible affordable activation exceeding
a work limit produces truncated with resource, observed/limit and cause.
Attempted reaction work survives failure; committed uses, resources, queue, status,
force, hit ledger, PRNG, IDs and journal all roll back. A committed boundary survives
a failed following interval. No partial wave records/checkpoints are yielded.

Stable actor/ability order serializes commutative groups, not mechanical precedence.
Logical point order and wave index differ from ancestry depth. Event `wave` is the
current effect wave; `reaction.wave` identifies the activation's trigger wave.
Causal event IDs precede children; ordinary phase/subtime display ordering remains.
Before-defeat ancestry and causes include only applications targeting that owner;
an opponent's unrelated reaction wave cannot increase its depth.
Undefined accepted G-03 interference reports unresolved with revisions and bounded
point/step/actor/causes. Unexpected errors remain failures.

## Knowledge and recorded replay

G-05 assesses own response, power/status utility, timing, shape, costs, uses and
readiness outside the main-action lottery. Visible threats give a low-confidence
parry estimate. An advisory HP/MP/stamina reserve influences action cost assessment
and gait allocation; it never holds resources or guarantees activation. Automatic
triggers still use the common eligibility/group payment rules. Enemy inputs are
only delayed visible activation cues (`point/response`), never unused abilities,
IDs, costs, exact resources, clocks or a queued future counter.

Optional ActorDisplay.reactions keeps the latest actual activation per owned
ability: ID, point/wave/depth, actual clocks, paid queue state and released ray.
Replacement deltas/checkpoints store it; decision hashes include it. ReplayState
validates definitions, queue uniqueness, clocks and geometry without importing the
engine. Old omitted fields remain readable. Worker/SQLite tests compare direct
results/records and seek both directions.

## Acceptance and scope

`parry-v1`, `riposte-v1` and `reaction-duelist-v1` are additive data examples.
Mapped tests cover whole/damage parry, old element cohorts across waves, shared
shield/heal/defeat, filters/silence, cost groups, deferred release/cancellation,
cross-interval depth, limits/rollback, private information, malformed replay,
Worker persistence and deterministic saved records. Existing fixed recipe identities
change only for engine/rules; expected results are not regenerated.
P6 retains reflection/absorption/revival and their competing-replacement rules.
