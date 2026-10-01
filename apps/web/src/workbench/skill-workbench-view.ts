import { SKILL_DANS, SKILL_PATHS, SKILL_ZODIACS, type SkillNode } from '@fantasy/domain';
import type { SkillAbility } from './skill-api.ts';
import type { WorkbenchNodeState } from './skill-workbench-state.ts';

export type SkillFilters = {
  query: string;
  path: string;
  zodiac: string;
  dan: string;
};

const pathById = new Map(SKILL_PATHS.map((item) => [item.id, item]));
const zodiacById = new Map(SKILL_ZODIACS.map((item) => [item.id, item]));
const danByNumber = new Map(SKILL_DANS.map((item) => [item.dan, item]));
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('ja').trim();

export function skillNodeSearchText(node: SkillNode) {
  const path = pathById.get(node.coordinate.path);
  const zodiac = zodiacById.get(node.coordinate.zodiac);
  const dan = danByNumber.get(node.coordinate.dan);
  return normalize(
    [
      node.id,
      node.name,
      node.description,
      node.lifecycle,
      path?.id,
      path?.name,
      path?.role,
      zodiac?.id,
      zodiac?.name,
      zodiac?.tendency,
      dan?.name,
      dan?.deepening,
      node.deepening.kind,
      node.deepening.explanation,
      node.deepening.conditionOrTradeoff,
      ...node.pathRoleTags,
      ...(node.weaponTags ?? []),
      ...node.resolution.flatMap((item) =>
        item.kind === 'augment'
          ? [item.kind, item.baseAbility.id, item.resolvedAbility.id]
          : [item.kind, item.ability.id],
      ),
    ]
      .filter(Boolean)
      .join(' '),
  );
}

export function filterSkillNodes(nodes: SkillNode[], filters: SkillFilters) {
  const query = normalize(filters.query);
  return nodes.filter(
    (node) =>
      node.coordinate.path === filters.path &&
      (filters.zodiac === 'all' || node.coordinate.zodiac === filters.zodiac) &&
      (filters.dan === 'all' || node.coordinate.dan === Number(filters.dan)) &&
      (!query || skillNodeSearchText(node).includes(query)),
  );
}

const refKey = (value: { id: string; revision: number; contentHash: string }) =>
  `${value.id}@${value.revision}:${value.contentHash}`;

export function abilitiesForNode(node: SkillNode, abilities: SkillAbility[]) {
  const indexed = new Map(abilities.map((ability) => [refKey(ability), ability]));
  const references = node.resolution.flatMap((item) =>
    item.kind === 'augment' ? [item.baseAbility, item.resolvedAbility] : [item.ability],
  );
  return references.map((reference) => ({ reference, ability: indexed.get(refKey(reference)) }));
}

const reasonText = (reason: string, nodes: Map<string, SkillNode>) => {
  if (reason === 'not-eligible') return 'このキャラクターでは未解禁です';
  if (reason.startsWith('lifecycle:')) {
    const lifecycle = reason.slice('lifecycle:'.length);
    if (lifecycle === 'draft') return 'ドラフトのため利用できません';
    if (lifecycle === 'implemented') return '実装済みですが、利用可能として公開されていません';
    if (lifecycle === 'retired') return '廃止済みのため利用できません';
    return `ライフサイクルが ${lifecycle} のため利用できません`;
  }
  if (reason.startsWith('missing:')) {
    const id = reason.slice('missing:'.length);
    return `前提「${nodes.get(id)?.name ?? id}」を先に習得してください`;
  }
  return reason;
};

export function workbenchReasonTexts(state: WorkbenchNodeState, nodes: SkillNode[]): string[] {
  const indexed = new Map(nodes.map((node) => [node.id, node]));
  return state.reasons.map((reason) => reasonText(reason, indexed));
}

export function formatAbilityCosts(ability: SkillAbility) {
  const { hp, mp, stamina, uses } = ability.definition.costs;
  return [
    `HP ${hp}`,
    `MP ${mp}`,
    ...(stamina === undefined ? [] : [`スタミナ ${stamina}`]),
    `使用回数 ${uses === 0 ? '無制限' : uses}`,
  ].join(' / ');
}

export function formatAbilityConstraints(ability: SkillAbility) {
  const definition = ability.definition;
  return [
    `条件 ${definition.condition.kind}`,
    `詠唱 ${definition.castSteps} step`,
    `硬直 ${definition.recoverySteps} step`,
    `再使用 ${definition.cooldownSteps} step`,
    `射程 ${definition.rangeMm} mm`,
    `詠唱中移動 ${definition.movementWhileCasting === 'allow' ? '可' : '停止'}`,
  ].join(' / ');
}
