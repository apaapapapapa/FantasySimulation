# ADR 0009: 観測と経験に基づく確率的AI

Adopted for #1/#9/#10/#45: one observation-based AI, pinned rules/policy,
empty-match-v1 knowledge, actor seeds and implementation digest. Saved/executable
compatibility follows [ADR0010](0010-battle-version-compatibility.md).
[Original full algorithm, constants, PRNG derivation and reference fixtures](https://github.com/apaapapapapa/FantasySimulation/blob/d2560db7a633601060a6993c187a91e3776149e3/docs/adr/0009-observed-ai.md)
remain historical evidence; current G-01–04 contracts are consolidated in
[spatial rules](../rules/spatial-v1.md). [ADR0012](0012-stages-and-reactions.md)
proposes later stages/reactions, without implementing #45 slots/posture.

AI receives self knowledge and delayed visible observations, never hidden enemy
resources/resistances/abilities/positions/randomness, definition reverse lookup or
omniscient replay. Only perception/effect-observation sees truth. Typed reveal
requires actual acquisition/delay/expiry; memory/PRNG is bounded, match-local and
transactional. Coarse impact estimates are defense-inclusive; unseen is not zero.

Shared damage/status assessment computes situational value/risk/cost/time/information;
G-03 replaces unconditional status weights. Combat revalidates feasible candidates;
physics decides dodge success. No ID/order bonuses, fixed extinguish probability,
unsupported posture or outcome guarantee. Unbiased purpose-separated sampling keeps
sole-candidate draws at zero. Subjective decisions stay separate from actual effects.
Preserve historical replay fixtures. Current contracts and original numeric details
are linked above; this consolidation changes no algorithm or acceptance requirement.
