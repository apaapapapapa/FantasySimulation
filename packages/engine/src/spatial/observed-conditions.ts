import type { Condition, DeepReadonly } from '@fantasy/domain/spatial/execution';
import type { DecisionView } from './perception.ts';
import { dot, length, sub, unit } from './math.ts';

export function usesObservedConditions(condition: DeepReadonly<Condition>): boolean {
  switch (condition.kind) {
    case 'observed-wounds':
    case 'observed-phase':
    case 'observed-status':
    case 'relative-position':
      return true;
    case 'all':
    case 'any':
      return condition.children.some(usesObservedConditions);
    case 'not':
      return usesObservedConditions(condition.child);
    default:
      return false;
  }
}
type ObservedCondition = Extract<
  Condition,
  { kind: 'observed-wounds' | 'observed-phase' | 'observed-status' | 'relative-position' }
>;
/** Unknown stays unknown under negation. Last-seen memory is not a current condition. */
export function observedCondition(
  condition: DeepReadonly<ObservedCondition>,
  view: DecisionView,
): boolean | undefined {
  const enemy = view.memory.observation?.enemy;
  if (!enemy) return undefined;
  switch (condition.kind) {
    case 'observed-wounds':
      return enemy.wounds === undefined ? undefined : enemy.wounds === condition.stage;
    case 'observed-phase':
      return enemy.action === undefined ? undefined : enemy.action === condition.phase;
    case 'observed-status':
      return (enemy.statuses ?? []).some((s) => s.id === condition.id) === condition.present;
    case 'relative-position': {
      const relative = sub(view.self.position, enemy.position);
      if (condition.relation === 'above') return relative.y > 0.1;
      if (condition.relation === 'below') return relative.y < -0.1;
      const facing = { ...enemy.facing, y: 0 },
        horizontal = { ...relative, y: 0 };
      if (length(horizontal) < 1e-12 || length(facing) < 1e-12) return undefined;
      const cosine = dot(unit(horizontal), unit(facing));
      return condition.relation === 'front'
        ? cosine >= 0.5
        : condition.relation === 'behind'
          ? cosine <= -0.5
          : Math.abs(cosine) < 0.5;
    }
  }
}
