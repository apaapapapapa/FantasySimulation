import type { Condition, DeepReadonly } from '@fantasy/domain/spatial/execution';
import type { DecisionView } from '../state.ts';
import { length, sub } from '../math.ts';
import { observedCondition } from './observed-conditions.ts';

export function conditionMatches(condition: DeepReadonly<Condition>, view: DecisionView): boolean {
  return evaluateCondition(condition, view) === true;
}
function evaluateCondition(
  condition: DeepReadonly<Condition>,
  view: DecisionView,
): boolean | undefined {
  switch (condition.kind) {
    case 'always':
      return true;
    case 'resource': {
      const max =
        condition.resource === 'stamina'
          ? (view.self.actor.character.stamina?.max ?? 0)
          : view.self.actor.character.stats[condition.resource];
      return (
        max > 0 && (view.resources[condition.resource] ?? 0) * 10000 < max * condition.belowBps
      );
    }
    case 'distance': {
      const target = view.memory.observation?.enemy ?? view.memory.lastSeen;
      return (
        !!target && length(sub(target.position, view.self.position)) * 1000 <= condition.withinMm
      );
    }
    case 'visible':
      return !!view.memory.observation?.enemy === condition.value;
    case 'status':
      return view.statusIds.includes(condition.id) === condition.present;
    case 'projectile-observed':
      return (view.memory.observation?.projectiles.length ?? 0) > 0;
    case 'observed-wounds':
    case 'observed-phase':
    case 'observed-status':
    case 'relative-position':
      return observedCondition(condition, view);
    case 'all': {
      const values = condition.children.map((c) => evaluateCondition(c, view));
      return values.includes(false) ? false : values.includes(undefined) ? undefined : true;
    }
    case 'any': {
      const values = condition.children.map((c) => evaluateCondition(c, view));
      return values.includes(true) ? true : values.includes(undefined) ? undefined : false;
    }
    case 'not': {
      const value = evaluateCondition(condition.child, view);
      return value === undefined ? undefined : !value;
    }
    default: {
      const impossible: never = condition;
      throw new Error(`Unknown condition: ${String(impossible)}`);
    }
  }
}
