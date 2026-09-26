import type { Definition, Effect, Revision } from './contracts.ts';
import type { MechanicId } from './mechanics.ts';

export type MechanicUse = {
  mechanic: MechanicId;
  owner: Pick<Revision, 'kind' | 'id' | 'revision' | 'contentHash'>;
};
export const effectMechanics = {
  damage: 'damage',
  heal: 'heal',
  shield: 'shield',
  'apply-status': 'apply-status',
  dispel: 'dispel',
  water: 'elemental-reaction',
  reveal: 'reveal',
  force: 'force',
} satisfies Record<Effect['kind'], MechanicId>;
export const attackMechanics = {
  direct: 'contact',
  arc: 'contact',
  radial: 'contact',
  melee: 'contact',
  hitscan: 'contact',
  projectile: 'projectile',
} satisfies Record<Definition<'ability'>['attack']['kind'], MechanicId>;
export const responseMechanics = {
  parry: 'parry',
  effects: 'reaction-effects',
  counter: 'counter',
  deflect: 'projectile-deflection',
} satisfies Record<NonNullable<Definition<'ability'>['reaction']>['response']['kind'], MechanicId>;
export const periodicMechanics = {
  damage: 'damage',
  heal: 'heal',
  resource: 'resource',
} satisfies Record<Definition<'status'>['periodic'][number]['kind'], MechanicId>;
export const statusResponseMechanics = {
  none: 'elemental-reaction',
  remove: 'elemental-reaction',
  strengthen: 'elemental-reaction',
  transform: 'apply-status',
} satisfies Record<
  NonNullable<Definition<'status'>['reactions']>[number]['response']['kind'],
  MechanicId
>;
export const motionMechanics = {
  dash: 'motion',
  retreat: 'motion',
  leap: 'motion',
} satisfies Record<
  NonNullable<NonNullable<Definition<'ability'>['stages']>[number]['selfMotion']>['kind'],
  MechanicId
>;

/** Visit the resolved revision closure, including dormant branches and transformed/granted states. */
export function closureMechanics(revisions: readonly Revision[]): MechanicUse[] {
  const uses: MechanicUse[] = [];
  for (const owner of revisions) {
    const found = new Set<MechanicId>();
    const add = (mechanic: MechanicId) => {
      found.add(mechanic);
    };
    const effects = (values: readonly Effect[]) => {
      for (const effect of values) {
        const mechanic = effectMechanics[effect.kind];
        if (!mechanic) throw new Error('Unclassified effect variant');
        add(mechanic);
        if (effect.kind === 'damage' && effect.drainBps !== undefined) add('drain');
        if (effect.kind === 'apply-status' && effect.flightStaminaPerSecond !== undefined)
          add('flight');
      }
    };
    if (owner.kind === 'ability') {
      const ability = owner.definition;
      effects(ability.effects);
      add(attackMechanics[ability.attack.kind]);
      if (ability.reaction) add(responseMechanics[ability.reaction.response.kind]);
      if (ability.stages) {
        add('stages');
        for (const stage of ability.stages) {
          effects(stage.effects);
          if (stage.attack) add(attackMechanics[stage.attack.kind]);
          if (stage.selfMotion) add(motionMechanics[stage.selfMotion.kind]);
        }
      }
    } else if (owner.kind === 'status') {
      const status = owner.definition;
      if (status.adjustments?.some((a) => a.target === 'absorption')) add('attribute-absorption');
      if (status.categories?.includes('permanent')) add('permanent');
      if (status.modifiers.flight || status.flightStaminaPerSecond !== undefined) add('flight');
      if (status.modifiers.silenced) add('silence');
      if (status.visibility) add('visibility');
      if (
        status.adjustments?.length ||
        status.modifiers.attack ||
        status.modifiers.defense ||
        status.modifiers.speedBps !== 10000 ||
        status.modifiers.rooted
      )
        add('status-adjustment');
      if (status.periodic.length) add('periodic');
      for (const effect of status.periodic) add(periodicMechanics[effect.kind]);
      if (status.burning || status.reactions?.length) add('elemental-reaction');
      for (const reaction of status.reactions ?? [])
        add(statusResponseMechanics[reaction.response.kind]);
    }
    for (const mechanic of [...found].sort()) {
      if (!mechanic) throw new Error('Unclassified mechanic variant');
      uses.push({
        mechanic,
        owner: {
          kind: owner.kind,
          id: owner.id,
          revision: owner.revision,
          contentHash: owner.contentHash,
        },
      });
    }
  }
  return uses;
}
