# ADR 0021: Bounded dependent summons

Status: accepted #228; runtime pending.

`dependent-entities-v1` adds bodies, not participants. Each stores immutable A/B owner,
hostile owner, committed ordinal, HP/collision, global lifetime/upkeep, subject
`nextActionAt` and policy. Targets are hostile participant/dependents; owner support and
self-dismiss are explicit. Caps are two concurrent/eight created. Teams, transfer,
nesting and dependent victory are excluded.

One scheduler orders by due time, owner slot, ordinal and ID. Paid commands deliver only
legal recorded observation. Freeze pauses subject time, not lifetime/upkeep. The existing
transaction settles guard/drain waves, revival, participant HP, defeated-owner
despawn, then win/draw. Terminal cannot revive; only unreleased actions cancel.

Possession keeps slot/upkeep/HP/status, removes the body and grants declared capability
on the participant clock without another turn. Release tries finite collision-valid
offsets or remains possessed. RNG binds seed, owner slot, ordinal, entity ID and purpose,
never enumeration/command order.

New manifest/replay pins create, command, act, damage, possession/release, despawn,
owner and target. Replay/API/Worker/SQLite/cameras/actor views/2D/3D consume records, not
AI. Old omission retains old behavior. Rollback disables new execution/publication and
never rewrites saved data.

Fixtures cover observation/clocks/release, guard/drain/revival/defeat, symmetry, bounds,
persistence/reverse and peak load. Rat dan deepen summon, command, coordination,
possession, two bodies and a costly spirit. Nodes await gates.
