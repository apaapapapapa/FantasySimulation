# Reactions (spatial-v1.21)

Refs #61 G-08, #155 P6-01; [design](../adr/0012-stages-and-reactions.md),
[P6 foundation](../adr/0016-p6-foundation.md). Omitted reactions retain existing
results/events/PRNG. Published definitions remain readable; old execution is rejected.

## Responses and eligibility

- `before-hit`: direct self effects (shield/heal/status/dispel/water), `parry`
  (`all` or `damage`, empty payload), or `deflect` (empty payload).
- `after-damage`: non-restorative self effects or deferred enemy hitscan `counter`.
  Trigger on positive hostile post-shield rational damage, before HP clipping or
  simultaneous healing. Costs/environment/self damage and full shields cannot trigger.
- `before-defeat`: non-restorative direct effects on provisional HP0 after all waves.
  This is not revival. P6-03 owns restoration.

Cast=0; no authored stages/motion. Categories and elements are ANDed; each list is
ORed. Categories follow G-01 including legacy MP defaults. Elements match damage/water.
Before-defeat has no contact filters. Conditions use the owner's delayed view.
Old capabilities, provisional resources, cooldown and uses determine eligibility.
Each ability activates at most once per owner/point/wave. Eligible costs reserve and
pay together through ResourceBudget; shortage pays none. Exhausted uses disable it.
Recovery/cooldown begin at activation; readiness is their maximum, separate from main.

Whole parry cancels every matching contact payload, including force/status/element
reactions. Damage parry cancels matching damage components only; element contacts
remain and zero-damage events retain causes. Accepted contacts consume hit ledgers.
Counters keep paid activation/depth, never refund, and release no earlier than the
next interval. Recheck life, silence/incapacity, condition, observed range/facing;
shared hitscan checks actual geometry. Two aim draws occur only on release. Defeat
cancels paid queues. No parallel main action slot or new resource implementation.

## Projectile deflection

`standard-deflection-v1` / `standard-tactics-deflection-v1` add P6-01. Deflect only
initial projectile **body contacts**, never wall blast, melee/hitscan or periodic
payloads. Eligibility consumes the original staged hit ledger; the replaced contact
has no payload or explosion. Same-contact parry is suppressed before grouped costs.
Other direct self responses retain normal grouped eligibility. Cancelled blast
exposure is removed before settling other owners' costs; planning converges within
owners+1 passes without priority by ID. Matching deflectors on one owner all pay,
produce one turn, and multiply `powerBps` (default10000, range0..30000) exactly once,
with one final floor/cap30000 independent of enumeration order.

Use the defender's delivered observation of the original attacker (body centre),
otherwise reverse incoming velocity. Coincident observed centre also reverses.
Preserve incident speed, gravity and original expiry; disable homing. Transfer owner
but preserve the launch snapshot, categories and payload; only the explicit power
multiplier changes damage power before defense; other payloads stay unchanged.
Hold at contact centre until the next interval, then
move along recorded segments. A returned projectile never deflects again; parry and
other normal defenses still apply. Its next collision can explode normally.
Original attacker/source references persist separately from current ownership.

Deflection activations count toward normal work limits and carry ancestry into
later contacts/reactions. Expiry on the turn boundary still expires; no extra life.
Display-path overflow truncates rather than dropping segments. Events store contact,
owner, incident/outgoing velocity, observed/reverse basis, power and activations.
Replacement projectile deltas/checkpoints preserve these fields. ReplayState validates
references, single ownership transition, causal IDs, speed/direction and power without
engine imports. Every activation must name the same parent body contact among its causes.
The event commits at boundary subtime0; its parent contact binds the recorded point/subtime.
An expiring turn requires removal at interval subtime1000000, after the contact hold.
The saved path must hold the contact centre through fraction1; contact times use rounded
microseconds, and boundary contacts require only the matching endpoint.
Both viewers show returned bullets in green, a recorded turn marker,
velocity arrow and the saved polyline. No trajectory is inferred.

## Atomic settlement and observation

The 20ms coordinator owns clones/rollback. Startup precedes expiry/resource/periodic
HP. Boundary and interval are separate transactions; no extra final boundary pulse.
Movement/contacts precede before-hit, primary damage/healing/shield, after-damage,
before-defeat, status commit and verdict. G-02 exact attribution/shared shields/single
HP clamp and G-03 old cohorts remain shared. Remove beats strengthen, conflicting
transforms are unresolved, permanent protection holds, transforms are not recursive.

Caps: 64 activations/transaction,1024/match,depth8,64 queued counters/owner; budgets
may lower them. Empty waves add no depth; before-defeat follows only incoming causes.
Exceeding work limits yields truncated(resource,observed,limit,cause). Attempted work
survives rollback; resources/uses/queue/status/force/hits/PRNG/IDs/events do not.
A committed boundary survives failed interval. Stable order serializes commutative
sets, never decides precedence. `wave` and ancestry depth are separate.

Own reactions use definition, threat, cost/uses/readiness for an advisory reserve;
they are not main-action candidates. Deflect considers observed projectiles only.
Enemy knowledge contains delayed visible activation cues only, never unused abilities,
IDs/costs/remaining uses/conditions or queued attacks. A delivered deflect cue is bounded
memory until normal knowledge expiry and halves subsequent projectile success estimates;
no guaranteed efficacy is inferred. Decision/knowledge events retain this uncertainty.
Returned bullets use ordinary observed projectile threat/evasion paths.

ActorDisplay.reactions stores actual activation/clocks/queue/ray; old omissions work.
Source tests cover cost/filter/shape boundaries, power/force/status/explosion, ancestry
rollback, all49 new ordered interference pairs,484 immutable legacy pairs, delayed
knowledge, Worker/SQLite and replay seeks. New samples are mirror-guard-v1 and
mirror-shooter-v1. Official league updates wait for the full first-group milestone.
P6-02 absorption/drain share these waves: cancelled contacts cannot heal; returned
damage uses target absorption and never drains for either owner (#155 §4).
