# ADR 0012: 技の段・攻撃形状・移動・反応型発動

状態: **設計承認済み**（[承認](https://github.com/apaapapapapa/FantasySimulation/pull/86#issuecomment-5792777109)）。
Refs #61 G-06/§2-E,F, #45, #59, #1 P6.

## 1. 採用案・前提

G-01–05 are merged; #45 simultaneous slots precede G-07. Recheck live main/PRs.
Later #45/#59/#61 override parent text; G-05 confirmed §7.

One20ms clock, stage/shared ledger and bounded transactional waves; simulate.ts orchestrates
G-01 categories/G-02 damage/G-03 status/G-04 resources/geometry and G-05 views.
No duplicate loops, recursive callbacks, contact-order HP, character scripts or future prepayment.
Interruption is boundary-based; finer timing needs versioning.

## 2. 段・時計・中断

G-07a implements the stage clocks, costs and interruption contract in
[canonical rules](../rules/stages-motion.md). G-07b extends them; G-08 owns reaction waves.

## 3. 形状・命中・移動

G-07 implements the [shape/force/motion contract](../rules/stages-motion.md).
Future emitter/beam/area/teleport and posture capabilities remain rejected until their own acceptance work.

## 4–5. 同時選択・資源・処理順

G-07 implements the [shared stage/movement resource contract](../rules/stages-motion.md#同時選択資源).
G-08 implements the [reaction contract](../rules/reactions.md): before-hit, after-damage,
before-defeat; grouped current-resource payment; old-cohort status union; shared
shield/clamp; whole/damage parry and paid deferred counters. That document owns
implemented clocks, filters, atomicity, information boundaries and acceptance.

P6 hooks are designed, not implemented in G-06/G-08:

- Absorption diverts post-modifier/pre-shield damage to same-wave healing. That
  portion cannot also drain shield/reflect; competing absorbers need a fraction rule.
- Reflection basis: hostile post-defense/resistance/**shield**, before remaining-HP
  clipping or simultaneous-heal cancellation (#1). Exclude costs, environmental/
  nonhostile damage and reflections. Rational component attribution, floor once per
  owner/source/component after reflection Bps; no new attack scaling/dealt bonus.
  Recipient defense/resistance/shield still apply; preserve causes even at HP0.
  Reflections may be defended, never reflected again.
- Same-wave healing precedes before-defeat. Revival is explicit restoration, not
  ordinary heal/counter recursion. Gather all HP0 owners, reserve all-or-none per
  owner; finite uses/explicit rules govern competing revivals. Undefined revive/
  annihilation or competing replacement is unresolved.

## 6–7. 上限・原子性・観測・保存

[Canonical reaction rules](../rules/reactions.md#atomic-waves-and-limits) implement
64/transaction,1024/match,depth8 with cross-interval ancestry and rollback; existing
geometry/record limits remain. G-08 exposes only actual delayed visible reactions,
records paid queues/clocks/geometry and validates replay without engine execution.
P6 additionally caps revival at4/actor/match. Undefined revival/annihilation or
competing replacement remains unresolved; no P6 capability is implemented here.

## 8. データ例と机上受入（実装試験ではない）

G-07 numerical acceptance is executable in the mapped stage/motion/force/blade tests.
Reaction examples below use zero defenses unless stated; G-08 tests execute the non-P6 cases.

- 受け流し／反撃: full parry consumes hit/cancels payload; positive-damage counter
  queues n+1, actual geometry decides its hit.
- 同時致死: bothHP10/take15, A heals6 → A1/B0 after reactions/A wins;
  without heal/revival → draw.
- 反射／蘇生(P6): B HP10/shield5 takes30/heals8 → basis25,B0;
  50% reflection12 kills A HP12, no re-reflect. B revival7→B wins; neither→draw.
- 上限: eligible65th with cap64 rolls back all64/cost/PRNG/hits. Undefined
  parry-vs-pierce→unresolved; neither omits a reaction to award a winner.

## 9. 実装・検証

G-07a #95 and G-07b #97 follow merged #45. G-08 follows G-07, with one
owner for coordinator/domain/log changes and shared G-03/G-04/G-05 adapters.
[Stage](../rules/stages-motion.md) and [reaction](../rules/reactions.md) rules own the
implemented acceptance matrix. #61 §2-I, independent fixtures, saved replay/Worker
round trips, Linux verify/clean-source/latest-head review and post-merge CI apply.
Reflection/absorption/revival and P4/P5 remain separate.

## 10. 版更新・承認証跡

[ADR0010](0010-battle-version-compatibility.md) owns additive schema, published
identity preservation, versioned mechanics, reviewed digest/corpus inputs and old
readers/execution rejection. No historical engine or DB conversion. PRs record
head/reviewer/findings; self-review is not approval. User design approval above
and implementation delivery/main CI are separate evidence in #61.
