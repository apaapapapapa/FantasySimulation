# ADR 0009: 観測と経験に基づく確率的AI

Adopted for #1/#9/#10/#45: one observation-based AI, pinned rules/policy,
empty-match-v1 knowledge, actor seeds and implementation digest. Saved/executable
compatibility follows [ADR0010](0010-battle-version-compatibility.md).
[Original full algorithm, constants, PRNG derivation and reference fixtures](https://github.com/apaapapapapa/FantasySimulation/blob/d2560db7a633601060a6993c187a91e3776149e3/docs/adr/0009-observed-ai.md)
remain authoritative for observed-utility-v1 except subsequent G-03/G-05 changes in
[spatial rules](../rules/spatial-v1.md). [ADR0012](0012-stages-and-reactions.md)
defines stages/reactions. #45 simultaneous slots are in spatial-v1.15; posture remains pending.

AI consumes bounded, match-local self knowledge and delayed visible evidence; no hidden
enemy state, ID reverse lookup or replay inputs. Typed reveals honor acquisition/expiry;
unseen impacts are unknown. Memory/PRNG updates are transactional. Shared assessment
weighs damage/status value, risk, cost, time and information without ID/order bonuses.
Physics revalidates execution/evasion; subjective logs never guarantee outcomes.
Unbiased purpose streams consume no draw for sole candidates. Preserve saved replay
fixtures. Current rules and original numeric contracts are linked above.
