import {
  SKILL_DANS,
  SKILL_PATHS,
  SKILL_ZODIACS,
  revisionRefKey,
  skillResolutionAbilityRefs,
  type SkillNode,
  type SkillSelectionReason,
  type SkillPreviewReason,
} from '@fantasy/domain';
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

export function abilitiesForNode(node: SkillNode, abilities: SkillAbility[]) {
  const indexed = new Map(abilities.map((ability) => [revisionRefKey(ability), ability]));
  return skillResolutionAbilityRefs(node.resolution).map((reference) => ({
    reference,
    ability: indexed.get(revisionRefKey(reference)),
  }));
}

const reasonText = (reason: SkillSelectionReason, nodes: Map<string, SkillNode>) => {
  if (reason.code === 'not-eligible') return 'このキャラクターでは未解禁です';
  if (reason.code === 'unavailable-node') {
    if (reason.lifecycle === 'draft') return 'ドラフトのため利用できません';
    if (reason.lifecycle === 'implemented')
      return '実装済みですが、利用可能として公開されていません';
    if (reason.lifecycle === 'retired') return '廃止済みのため利用できません';
    return '実行可能な定義がないため利用できません';
  }
  if (reason.code === 'unmet-learning-prerequisite') {
    const id = reason.prerequisiteNodeId;
    return `前提「${nodes.get(id)?.name ?? id}」を先に習得してください`;
  }
  if (reason.code === 'weapon-requirement')
    return `必要な武器タグ「${reason.weaponTag}」を確認できません`;
  if (reason.code === 'augment-base-not-owned')
    return `強化元「${reason.baseAbility.id}」の指定版を所持していません`;
  if (reason.code === 'enabled-node-not-learned') return '編成する前に習得してください';
  if ('maximum' in reason) return `編成上限を超えています（${reason.count}/${reason.maximum}）`;
  return reason.code;
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

export function skillPreviewReasonText(reason: SkillPreviewReason, nodes: SkillNode[]) {
  if (reason.code === 'receipt-selection')
    return '能力の組み合わせ、解決数、または空の編成を保存できません。';
  if (reason.code === 'ability-application') {
    const labels: Record<typeof reason.reason, string> = {
      'active-trigger': '発動技のtriggerが一致しません',
      'passive-trigger': '常時効果のtriggerが一致しません',
      'augment-identity': '強化先の能力identityが一致しません',
      'augment-trigger': '強化前後のtriggerが一致しません',
      'augment-base-not-owned': '指定版の強化元能力を所持していません',
      'duplicate-augment': '同じ元能力への強化が重複しています',
      'conflicting-grant': '同じ能力IDの異なる定義が競合しています',
      'definition-reference': '指定した能力定義を確認できません',
    };
    return `${labels[reason.reason]}${reason.abilityId ? `（${reason.abilityId}）` : ''}`;
  }
  return reasonText(reason, new Map(nodes.map((node) => [node.id, node])));
}
