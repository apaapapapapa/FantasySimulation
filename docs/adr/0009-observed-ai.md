# ADR 0009: 観測と経験に基づく確率的AI

Adopted for #1/#9/#10/#45: one observation-based AI, pinned rules/policy,
empty-match-v1 knowledge, actor seeds and implementation digest. Saved/executable
compatibility follows [ADR0010](0010-battle-version-compatibility.md).
[Original full algorithm, constants, PRNG derivation and reference fixtures](https://github.com/apaapapapapa/FantasySimulation/blob/d2560db7a633601060a6993c187a91e3776149e3/docs/adr/0009-observed-ai.md)
remain authoritative for observed-utility-v1 except subsequent G-03/G-05 changes in
[spatial rules](../rules/spatial-v1.md). [ADR0012](0012-stages-and-reactions.md)
defines stages/reactions; simultaneous slots use spatial-v1.15.

[Tactical AI](../rules/tactical-ai.md): relative impacts, reapplication, search,
posture and cover. Values approved on 2026-09-24; existing contracts above apply.
