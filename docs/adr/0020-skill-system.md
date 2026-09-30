# ADR 0020 proposal: skill catalog, loadouts and combat integration

**Status: accepted for implementation by delegated technical decision, 2026-09-30.**
Refs #228. Baseline `a9c45d65ddf673aa3683b6882620b8db1d23decd`.
The owner delegated approach and technical decisions while retaining the accepted
16 paths, zodiac order, six dan meanings and all twenty acceptance items. This is
not a claim that the owner individually approved the numbers below. They were
selected conservatively from current limits and must still pass the listed fixtures.

## 1. Findings and constraints

The current system has no path, zodiac, dan, skill-node, acquisition, profile or
loadout model. A character stores up to 32 direct ability references and eight
equipment references. Equipment, abilities, statuses, rules, scenarios and
characters are immutable hashed revisions. Preparation closes and sorts their
dependencies, and a stored battle pins the full resolved manifest under its
`simulationHash`. Normal seeding and a battle manifest each cap the revision
closure at 256; the current published catalog has 193 revisions. Therefore the
1,152-node browsing catalog cannot be encoded as 1,152 ordinary abilities, seeded
in one normal batch, or copied wholesale into every battle.

Reusable runtime mechanisms include ability stages (attack progress, not dan),
resources, statuses and their stack policies, adjustments, dispel/seal, reactions,
movement, barriers/areas/beams, subjective delayed observation, seeded AI choice,
decision/cognition records, immutable battle specs, replay artifacts and the shared
ReplayState feeding both 2D and 3D scenes. There are no summons, decoys, illusions,
sound observations or possession. The duel contract is exactly two participants;
display state and victory logic also require two actors.

## 2. Proposed architecture

### 2.1 Authoring catalog, configuration and execution are separate

Introduce a domain-owned `SkillCatalog` whose identity is
`(id, revision, contentHash)`. Its index fixes the 16 path IDs and display order,
the zodiac IDs/order `rat..boar`, dan 1..6 and exactly 1,152 unique coordinates.
Each path is a separately loadable shard of 72 nodes; the catalog manifest hashes
and orders all 16 shards. This catalog is authoring/browsing data, not an engine
revision closure.

Each `SkillNode` has stable ID, coordinate, name, description, lifecycle
(`draft|implemented|available|retired`), prerequisites, acquisition metadata,
target/weapon constraints, semantic tags for path/zodiac/dan, a meaningful
deepening explanation and a nonempty resolution recipe. A recipe may grant active
abilities, passives/status capabilities, modifiers or derived variants by exact
immutable revision reference. It cannot contain combat numbers that bypass the
owning ability/status/rules schemas. Only `available` nodes with an executable
recipe may enter a loadout. Draft and implemented-but-unreleased nodes remain
visible but unusable.

A locally editable `SkillConfiguration` distinguishes eligibility, learned nodes
and enabled nodes. Saves use optimistic version checks and append immutable
`SkillLoadoutRevision` snapshots; a mutable head only points to the latest saved
revision. A pure domain resolver validates the catalog/configuration, sorts all
set-like inputs by stable ID, closes prerequisites, rejects conflicts, and returns
`ResolvedSkillLoadout`: exact node IDs, exact executable revision references,
derived modifiers and a canonical resolution digest. Input order must not affect
the result.

Preparation adds an optional skill provenance receipt to a new stored-manifest
version: catalog ref/hash, loadout ref/hash, resolver version, selected node IDs,
node-to-definition refs and resolution digest. The executable manifest still
contains only the selected ordinary definition closure, never all 1,152 nodes.
The receipt and closure participate in `simulationHash`. Old manifests omit the
receipt and retain their current read/display/execution rules. Unsupported new
resolver/rules/engine identities fail execution; historical engines are not loaded.

Catalog revisions and loadout revisions need dedicated immutable Drizzle tables;
they must not be forced into `published_revisions` or silently added to old DBs.
Generate an additive official migration, preserve STRICT/check/trigger behavior,
and test an old database without the optional battle fields. Public deployments
may serve catalog shards read-only. Editing remains loopback/local until an
approved authenticated write design exists.

### 2.2 Dan, acquisition and equipment

`dan` is a node coordinate and mastery concept; `stages` remains an ability's
within-action timeline. The first release has no XP economy: eligibility
is derived from explicit prerequisites and simulator inputs, learning is an
explicit choice, and dan reach is derived per `(path,zodiac)` branch from learned
nodes rather than stored as an independent counter. Respec creates a new loadout
revision and has no price. This avoids inventing progression or monetization while
preserving a later additive acquisition policy.

The resolver must keep the selected execution closure inside existing engine
limits. Do not raise the 32 direct-ability, eight-equipment or 256-manifest limits
as a substitute for a loadout design. A configuration may learn all valid nodes but
enables at most two paths and twelve nodes: eight active and four passive/augment
nodes. Resolution reports the recipe that exceeds an executable limit. Weapon
requirements use explicit tags on exact equipment revisions; appearance is never
inventory. Switching is pre-battle only. SK-02 benchmarks these limits before SK-03..07.
Modifiers with the same explicit stack key use the owning status policy
(`sum|replace|refresh|reject`); no ID or input order resolves conflicts.

### 2.3 AI and observations

AI receives only the actor's resolved enabled abilities and legal subjective
observation. It never scans the catalog and never infers an enemy's unobserved
node, dan, exact value or future choice from a path/name. Generic capability and
effect descriptors extend the existing assessment; no path, node or character ID
branches are allowed. Decision records identify the evaluated resolved ability,
legal evidence and rejection reason.

For illusion, keep one canonical world and add bounded per-observer sensory cues.
A visual illusion or false sound is perceived information, not a combat actor: it
has no HP, collision, damage, victory eligibility or independent execution. Cue
records bind creator, affected observer, modality, perceived origin, delivery/
expiry, confidence and discovery/removal. AI consumes delivered cues through the
same observation boundary. Truth-mode replay and actor-perspective replay render
from recorded cues; neither recomputes perception. Sound requires explicit range,
occlusion, delay and memory rules rather than reuse of sight.

### 2.4 Dependent summoned entities

Do not reinterpret old duels. The recommended extension retains exactly two
participants and adds bounded `DependentEntity` bodies owned by one participant.
They are targetable, have finite HP/lifetime/upkeep, use deterministic owner-derived
RNG streams, and may execute only declared commands or a generic approved policy.
They are not participants or victory eligible. Owner defeat despawns dependents at
the next atomic boundary. Possession keeps its summon slot
and upkeep, removes the separate body, and grants only its declared capability
until release. A summon event/display record must distinguish create, command,
act, damage, dismiss/despawn and possess/unpossess.

This requires a separately approved amendment to ADR0014 covering hostility,
target selection, collision, simultaneous resolution, owner defeat, outcome,
observation, replay camera/state, RNG and bounds. Initial limits are two concurrent
dependents and eight creations per owner per match; fixture and load evidence may
lower them, but raising them requires a reviewed decision. General teams, free-for-all and ally
selection remain out of scope.

## 3. Catalog completeness and anti-placeholder gates

The machine-readable expected-coordinate generator, not a handwritten count, must
compare the exact 16x12x6 set with catalog nodes. It also validates stable IDs,
references, acyclic prerequisites, lifecycle, recipes and shard hashes. A second
semantic gate reports all 192 branches and requires:

- zodiac tags and behavior that fit both the shared tendency and the path role;
- a declared deepening relation for each dan transition, not only larger numbers;
- retained lower-dan use plus upper-dan condition/cost/risk/tradeoff;
- an executable recipe and at least one bound fixture for every available node;
- explicit differentiation fixtures for the four overlap-prone martial pairs;
- no draft, unsupported, empty or name-only node in completion counts.

The proposed companion fixture matrix is
[0020-skill-system-fixtures.json](0020-skill-system-fixtures.json). Evidence maps
node/branch IDs to unit, interaction, battle, persistence, AI, replay and UI tests.
Generation may report missing evidence but must never generate expected outcomes
from candidate behavior.

## 4. UI and loading

Reuse the workbench's catalog fetching, optimistic save/reload, battle job and
replay flow, but add a skill-specific accessible surface. Desktop displays a
six-dan (six to one) by twelve-zodiac table for one path; mobile uses a labelled
scrolling grid or list/detail without shrinking controls. Every node exposes name,
effect, prerequisite, target, cost, constraint, deepening and a machine-associated
reason when disabled. Statuses are distinct: locked, learnable, learned, enabled,
unsupported and retired. Search covers name, path, dan, zodiac and effect tags.

Load the 16-path index first, then one 72-node shard and bounded search pages. The
API validates every save independently of UI state. Accessibility fixtures cover
keyboard order, labels/headers, focus after detail/save, non-colour status text,
zoom and a phone viewport. Selection-save-reload-prepare-battle-replay is one E2E,
not separate mock completion.

## 5. Versioning, records and performance

Catalog content is append-only by `(id,revision,hash)`; node IDs are never aliases
for old names. Numeric or decision changes create new ability/status/rules revisions
and, when execution decisions change, a new rules/engine identity under ADR0010/13.
Existing characters receive no implicit configuration. Published samples, hashes,
old DBs, battle specs and replays remain byte-meaningful. Standard/experimental
rules and official league membership/scheduling are unchanged until a separate
approved rollout after full acceptance.

Every new mechanic is delivered vertically: input/resolution, engine, subjective
AI, cognition/decision and truth records, API/Worker/SQLite/artifact round trip,
ReplayState, then both viewers. New record shapes require explicit event/replay
version decisions and bounds. Seek, reverse and loop reconstruct recorded state
without engine execution or residue.

Measure resolver/catalog load, 72-cell rendering/search, selected candidate count,
engine CPU/RSS, entity/status/log peaks and compressed artifacts. AI complexity is
over resolved candidates, never 1,152. Existing gates remain; any new numeric
budget needs evidence and approval rather than a threshold increase.

## 6. Delivery order and parallel boundary

1. Approve this ADR choices and the ADR0014 extension boundary (SK-00).
2. One integration owner adds catalog/loadout/provenance schemas, resolver and
   completeness reports (SK-01). The same owner alone edits shared schema, storage,
   observation and record contracts.
3. Carry one representative branch through UI/save/resolution/battle/replay and
   measure proposed caps (SK-02).
4. Freeze contracts and file ownership; parallelize martial content/common effects,
   healing/buff/magic, illusion perception and dependent summons (SK-03..07).
   Each slice owns definitions and vertical fixtures, not shared contracts.
5. Fill and independently review all 1,152 meaningful nodes/evidence (SK-08), then
   run compatibility, performance, mobile, security, CI and application acceptance
   without changing league policy (SK-09).

## 7. Delegated decisions for SK-Q01 through SK-Q08

These defaults were selected under the owner's delegation and are implementation
inputs, not direct owner approval of each value:

| ID     | Decision and rationale                                                                                                                        |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| SK-Q01 | explicit simulator learning; branch-derived dan; no XP/cost; free revisioned respec                                                           |
| SK-Q02 | at most 2 enabled paths and 8 active + 4 passive/augment nodes; exact equipment tags; pre-battle switching; current closure limits            |
| SK-Q03 | immutable sharded catalog; combat numbers only in exact definition revisions; content reviewed in batches                                     |
| SK-Q04 | reuse explicit status stack policies; distinct curse/mental/illusion defenses; every control finite and counterable                           |
| SK-Q05 | per-observer visual/audio cues, canonical truth separate; sound gets its own range/occlusion/delay/memory contract                            |
| SK-Q06 | two participants plus owner-bound dependents; 2 concurrent/8 created per owner; owner defeat despawns next boundary; possession consumes slot |
| SK-Q07 | old data omitted-compatible; new system experimental first; standard/league rollout requires separate evidence and approval                   |
| SK-Q08 | one hashed index plus 16x72 shards, exact-set/semantic/evidence gates, accessible responsive table/list and measured lazy loading             |

This decision does not pre-approve 1,152 names or balance values. Those remain
reviewed catalog data with bound fixtures. Material contract changes are new
versioned decisions; implementation may now proceed in the order above.
