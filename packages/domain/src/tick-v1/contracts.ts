import { z } from 'zod';
import { canonicalJson, deepFreeze, hashJson } from './canonical.ts';

export const SlotSchema = z.enum(['left', 'right']);
export type Slot = z.infer<typeof SlotSchema>;
export const SLOTS = Object.freeze(['left', 'right'] as const);
const id = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,79}$/);
export const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const bounded = (max: number) => z.number().int().min(0).max(max);
const stat = bounded(10_000);
const resource = bounded(1_000_000);
const tick = bounded(1_000_000);
export const SeedSchema = z.number().int().min(1).max(0xffff_ffff);
const revision = <T extends z.ZodType>(definition: T) =>
  z.strictObject({
    revisionId: id,
    contentHash: HashSchema,
    definition,
  });

export const TickEffectSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('damage'),
    power: stat,
    damageType: z.enum(['physical', 'magical']),
    accuracyBps: stat,
    aim: z.enum(['roll', 'certain-hit']),
  }),
  z.strictObject({ kind: z.literal('heal'), amount: resource }),
  z.strictObject({ kind: z.literal('wait') }),
]);

export const TickAbilitySchema = z.strictObject({
  id,
  name: z.string().min(1).max(80),
  trigger: z.literal('action'),
  recoveryTicks: z.number().int().min(1).max(10_000),
  cost: z.strictObject({ hp: resource, mp: resource }),
  effect: TickEffectSchema,
});
export const TickAbilityRevisionSchema = revision(TickAbilitySchema);
export const TickStrategySchema = z.strictObject({
  id,
  kind: z.literal('cycle'),
  abilityRevisionIds: z.array(id).min(1).max(32),
});
export const TickStrategyRevisionSchema = revision(TickStrategySchema);
export const TickCharacterSchema = z.strictObject({
  id,
  name: z.string().min(1).max(80),
  sourceText: z.string().max(2_000),
  stats: z.strictObject({
    maxHp: z.number().int().min(1).max(1_000_000),
    maxMp: resource,
    attack: stat,
    defense: stat,
    speed: stat,
    resistanceBps: z.strictObject({ physical: stat, magical: stat }),
    avoidance: z.enum(['normal', 'certain-evade']),
  }),
  abilityRevisionIds: z.array(id).min(1).max(16),
  strategyRevisionId: id,
  // Equipment execution belongs to P2; do not accept and ignore unknown definitions.
  equipmentRevisionIds: z.array(z.never()).length(0),
});
export const TickCharacterRevisionSchema = revision(TickCharacterSchema);
export const TickParticipantSchema = z.strictObject({
  character: TickCharacterRevisionSchema,
  abilities: z.array(TickAbilityRevisionSchema).min(1).max(16),
  strategy: TickStrategyRevisionSchema,
  equipment: z.array(z.never()).length(0),
});
const participants = z.strictObject({ left: TickParticipantSchema, right: TickParticipantSchema });
export const TickStateSchema = z.strictObject({
  hp: resource,
  mp: resource,
  shield: resource,
  position: z.number().int().min(-10_000).max(10_000),
});
export const TickStatesSchema = z.strictObject({ left: TickStateSchema, right: TickStateSchema });
export const TickRulesSchema = z.strictObject({
  id: z.literal('tick-v1'),
  version: z.literal('0.2.0'),
  speedScale: z.literal(100),
  maxDelayTicks: z.literal(1_000_000),
  probabilityScale: z.literal(10_000),
  certainHitVsCertainEvade: z.literal('unresolved'),
});
export const TickRulesRevisionSchema = revision(TickRulesSchema);
export const TickScenarioSchema = z.strictObject({
  id,
  maxTick: tick,
  initialState: TickStatesSchema,
});
export const TickScenarioRevisionSchema = revision(TickScenarioSchema);

export const TickBattleDraftSchema = z.strictObject({
  participants,
  rules: TickRulesRevisionSchema,
  scenario: TickScenarioRevisionSchema,
  seed: SeedSchema,
});
export const TickManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    eventSchemaVersion: z.literal(1),
    canonicalization: z.literal('canonical-json-v1'),
    engine: z.strictObject({
      id: z.literal('tick-v1'),
      version: z.literal('0.2.0'),
      implementationDigest: HashSchema,
    }),
    random: z.strictObject({
      algorithm: z.literal('xorshift32-13-17-5-v1'),
      streamDerivation: z.literal('character-sha256-v1'),
      seed: SeedSchema,
    }),
    participants,
    rules: TickRulesRevisionSchema,
    scenario: TickScenarioRevisionSchema,
  })
  .superRefine((manifest, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (
      manifest.participants.left.character.definition.id ===
      manifest.participants.right.character.definition.id
    ) {
      fail('Two different character IDs are required');
    }
    const seenRevisions = new Map<string, string>();
    for (const entry of revisionsOf(manifest)) {
      const previous = seenRevisions.get(entry.revisionId);
      if (previous && previous !== entry.contentHash)
        fail(`Conflicting revision: ${entry.revisionId}`);
      seenRevisions.set(entry.revisionId, entry.contentHash);
    }
    for (const slot of SLOTS) {
      const participant = manifest.participants[slot];
      const character = participant.character.definition;
      const available = new Set(participant.abilities.map((ability) => ability.revisionId));
      const references = new Set(character.abilityRevisionIds);
      if (
        available.size !== participant.abilities.length ||
        references.size !== character.abilityRevisionIds.length
      )
        fail(`${slot}: duplicate ability revision`);
      if (available.size !== references.size || [...references].some((ref) => !available.has(ref)))
        fail(`${slot}: unresolved or extra ability reference`);
      if (character.strategyRevisionId !== participant.strategy.revisionId)
        fail(`${slot}: unresolved strategy reference`);
      if (participant.strategy.definition.abilityRevisionIds.some((ref) => !available.has(ref)))
        fail(`${slot}: strategy references missing ability`);
      const initial = manifest.scenario.definition.initialState[slot];
      if (
        initial.hp < 1 ||
        initial.hp > character.stats.maxHp ||
        initial.mp > character.stats.maxMp
      )
        fail(`${slot}: invalid initial resources`);
    }
  });

export type TickParticipant = z.infer<typeof TickParticipantSchema>;
export type TickAbility = z.infer<typeof TickAbilitySchema>;
export type TickCharacter = z.infer<typeof TickCharacterSchema>;
export type TickManifest = z.infer<typeof TickManifestSchema>;
export type TickBattleDraft = z.infer<typeof TickBattleDraftSchema>;
export type TickState = z.infer<typeof TickStateSchema>;
export type TickStates = z.infer<typeof TickStatesSchema>;

function revisionsOf(manifest: Pick<TickManifest, 'participants' | 'rules' | 'scenario'>) {
  return [
    manifest.rules,
    manifest.scenario,
    ...SLOTS.flatMap((slot) => {
      const participant = manifest.participants[slot];
      return [participant.character, participant.strategy, ...participant.abilities];
    }),
  ];
}

export async function validateTickManifest(input: unknown): Promise<Readonly<TickManifest>> {
  canonicalJson(input); // Reject cycles/accessors and oversized inputs before schema traversal.
  const manifest = TickManifestSchema.parse(input);
  await Promise.all(
    revisionsOf(manifest).map(async (entry) => {
      if ((await hashJson(entry.definition)) !== entry.contentHash)
        throw new Error(`Revision hash mismatch: ${entry.revisionId}`);
    }),
  );
  for (const slot of SLOTS) {
    manifest.participants[slot].abilities.sort((a, b) =>
      a.revisionId < b.revisionId ? -1 : a.revisionId > b.revisionId ? 1 : 0,
    );
  }
  return deepFreeze(manifest);
}

export const TickBudgetSchema = z.strictObject({
  maxEvents: bounded(50_000),
  maxTicks: bounded(50_000),
  maxLogBytes: z
    .number()
    .int()
    .min(2)
    .max(8 * 1024 * 1024),
});
const diagnostic = z.strictObject({
  code: z.literal('missing-interaction'),
  ruleId: z.literal('accuracy.certain-hit-vs-certain-evade'),
  tick,
  actor: SlotSchema,
  target: SlotSchema,
  abilityRevisionId: id,
});
export const TickOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('win'), winner: SlotSchema, reason: z.literal('defeat') }),
  z.strictObject({
    kind: z.literal('draw'),
    reason: z.enum(['simultaneous-defeat', 'time-limit']),
  }),
  z.strictObject({ kind: z.literal('unresolved'), diagnostics: z.array(diagnostic).min(1).max(2) }),
  z.strictObject({
    kind: z.literal('truncated'),
    reason: z.enum(['event-budget', 'tick-budget', 'log-byte-budget']),
    pendingTick: tick,
    limit: bounded(8 * 1024 * 1024),
    required: z.number().int().nonnegative(),
  }),
]);

const effectEvent = { tick, actor: SlotSchema, abilityRevisionId: id };
export const TickEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('start'),
    tick: z.literal(0),
    ruleId: z.literal('battle.start'),
    state: TickStatesSchema,
  }),
  z.strictObject({
    kind: z.literal('action'),
    ...effectEvent,
    ruleId: z.literal('action.commit'),
    effectKind: z.enum(['damage', 'heal', 'wait']),
    paidCost: z.strictObject({ hp: resource, mp: resource }),
    fizzleReason: z.enum(['insufficient-hp', 'insufficient-mp']).nullable(),
    nextActionTick: bounded(2_000_000),
  }),
  z.strictObject({
    kind: z.literal('damage'),
    ...effectEvent,
    ruleId: z.literal('damage.resolve'),
    target: SlotSchema,
    roll: bounded(9_999),
    hit: z.boolean(),
    baseDamage: bounded(20_000),
    afterResistance: bounded(20_000),
    absorbedByShield: bounded(20_000),
    damageToHp: bounded(20_000),
  }),
  z.strictObject({
    kind: z.literal('heal'),
    ...effectEvent,
    ruleId: z.literal('heal.resolve'),
    amount: resource,
  }),
  z.strictObject({ kind: z.literal('wait'), ...effectEvent, ruleId: z.literal('action.wait') }),
  z.strictObject({
    kind: z.literal('state'),
    tick,
    ruleId: z.literal('effects.commit'),
    before: TickStatesSchema,
    after: TickStatesSchema,
  }),
]);
export const TickReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  simulationHash: HashSchema,
  eventsHash: HashSchema,
  resultHash: HashSchema,
  outcome: TickOutcomeSchema,
  tick,
  processedTicks: bounded(50_000),
  finalState: TickStatesSchema,
  events: z.array(TickEventSchema).max(50_000),
  budget: TickBudgetSchema,
});
export type TickBudget = z.infer<typeof TickBudgetSchema>;
export type TickOutcome = z.infer<typeof TickOutcomeSchema>;
export type TickEvent = z.infer<typeof TickEventSchema>;
export type TickReport = z.infer<typeof TickReportSchema>;
