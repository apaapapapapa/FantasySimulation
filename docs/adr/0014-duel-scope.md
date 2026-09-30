# ADR 0014: Explicit duel scope

Status: accepted for Issue #106 D-3/R-09; dependent-entity amendment accepted by
delegated technical decision for Issue #228, 2026-09-30.

The product supports exactly two opposing participants. `DuelPair`, streams 0/1,
participant A/B controls, victory and first-participant camera keep that meaning.
Reject missing, duplicate or extra participants; never choose an arbitrary enemy.
The prior lookup identity transition remains recorded in its implementation artifact.

## Dependent-entity amendment

A versioned `dependent-entities-v1` feature may add bounded bodies without adding
participants. Each dependent has immutable owner A/B, creation ordinal, hostile
owner (the opponent), HP, collision, lifetime/upkeep, its own `nextActionAt`, and
declared commands/policy. It may target its hostile participant/dependents; owner
support and self-dismiss require explicit capabilities. There is no ally/team selector.

All actors use the one scheduler. Commands cost the declared owner action and are
delivered to AI/observers only through recorded legal observation; they are not free
or omniscient. Status, upkeep, expiry, collision and damage settle at atomic
boundaries. Existing participant guard/drain simultaneous settlement runs unchanged;
dependent effects enter as ordinary staged inputs, never a second settlement path.
Victory then reads only settled participant HP. Same-boundary healing means the owner
never became defeated; a settled defeat marks dependents for post-settlement despawn,
and a terminal outcome cannot be revived. Existing simultaneous defeat/draw remains.

RNG derives from match seed, owner slot, creation ordinal and stable entity ID, not
enumeration or command order. Possession retains its slot/upkeep, removes the separate
body and grants declared capability on the participant clock, never an extra turn.
Initial bounds are two concurrent and eight created per owner.

New manifest/replay versions pin the feature and record create, command, act, damage,
possess/release, dismiss/despawn, owner and target. Camera and actor-perspective views
consume recorded states/cues; replay never reruns AI. Old artifacts omit the feature
and retain old display/execution rules. General teams/free-for-all remain out of scope.
