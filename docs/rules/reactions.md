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
- `before-defeat`: non-restorative direct effects or explicit `revive` on provisional HP0 after all waves.

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

P6-01 retains its [complete recorded deflection contract](https://github.com/apaapapapapa/FantasySimulation/blob/43c6ddd365094de9e73e3b008191f91beaecc4fe/docs/rules/reactions.md#projectile-deflection):
one body-contact replacement per projectile, delayed observed aim, original launch snapshot,
new ownership, no homing/re-deflection/drain, next-boundary flight and bounded saved paths.

## Revival and sealing (P6-03/04)

`revive` is direct self `before-defeat`, with finite uses, zero HP cost and only optional
`dispel` effects. `health` is fixed positive `amount` or max-HP `bps` (1..10000): floor
once, minimum1, clamp to maxHP. This explicit reset is independent of ordinary healing
multipliers. One revival ability per loadout including equipment; at most4 uses/actor/match.
Exhaustion disables eligibility, not truncated. Conditions, categories, posture, incapacity,
cooldown, MP/stamina and grouped all-or-none reaction reservation remain shared.
All HP/shield/recovery and non-restorative waves settle first; eligible owners pay together,
then reset HP before verdict, including the last interval. No recursive heal/counter wave.
Cohorts, movement, objects and paid action lifecycles survive; optional dispels commit normally.
Events bind activation, before/after resources and cumulative use. ActorDisplay.revivals,
replacement deltas and ReplayState validate counts/HP/causes without engine execution.

Optional status `seals` selects abilityCategories, statusCategories and/or statusIds (union).
Next-boundary membership blocks matching starts/releases/reactions; silence keeps its existing
magic interpretation. Existing projectiles/detached objects retain snapshots; channels use
normal capability checks. Matching states retain membership and original expiry/pulse origin,
but contribute no modifiers, periodic effects or elemental responses. No missed-pulse catchup.
Seals cannot suppress any seal, preventing cycles. Dispel/permanent protection stays unchanged.
Suppressed flight falls normally; suppressed phasing invokes the accepted safe-exit contract.

Own AI estimates defined restoration/cost/remaining uses and sealing selectors; sealed choices
are logged. Enemy revival knowledge comes only from delayed visible activation, never remaining
uses/costs/conditions. It discounts later kill estimates until knowledge expiry. Visible sealed
statuses disappear from effective public effects, delivered through the existing observation delay.
Both viewers show recorded revival and seal rings; HP/use counts and temporarily suppressed
cohorts remain inspectable, including reverse/loop seeks. New samples: phoenix-duelist-v1,
seal-mage-v1. Additive spatial-v1.22 identity restamp; existing corpus/140 published definitions
remain unchanged. 124 ordered fixtures extend the matrix; first-group league publication is separate.

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

P6-02 absorption/drain share these waves: cancelled contacts cannot heal; returned
damage uses target absorption and never drains for either owner (#155 §4).
