import {
  MAX_ACTIVE_SKILL_NODES,
  MAX_ENABLED_SKILL_PATHS,
  MAX_PASSIVE_SKILL_NODES,
  type AnySkillLoadoutHead,
  type SkillAcquisitionHead,
  type SkillConfiguration,
  type SkillNode,
} from '@fantasy/domain';

export type WorkbenchStatus = 'eligible' | 'learned' | 'enabled' | 'locked' | 'disabled';
export type WorkbenchNodeState = { status: WorkbenchStatus; reasons: string[] };

export function latestSelectionGuard() {
  let latest = 0;
  return {
    begin() {
      const generation = ++latest;
      return { isCurrent: () => generation === latest };
    },
  };
}

/** Unsaved schema-v1 editor state that offers every available node as eligible. */
export function newSkillConfiguration(
  nodes: SkillNode[],
  catalog: SkillConfiguration['catalog'],
  id = `loadout-${crypto.randomUUID()}`,
): SkillConfiguration {
  return {
    schemaVersion: 1,
    id,
    version: 1,
    catalog,
    eligibilityNodeIds: nodes
      .filter((node) => node.lifecycle === 'available')
      .map((node) => node.id),
    learnedNodeIds: [],
    enabledNodeIds: [],
  };
}

/** Editor view of a saved loadout; schema-v2 learning comes from its exact resolved snapshot. */
export function savedSkillConfiguration(
  loadout: AnySkillLoadoutHead,
  acquisition: SkillAcquisitionHead | null,
): SkillConfiguration {
  if (loadout.snapshot.configuration.schemaVersion === 1) return loadout.snapshot.configuration;
  return {
    schemaVersion: 1,
    id: loadout.id,
    version: loadout.version,
    catalog: loadout.snapshot.configuration.catalog,
    eligibilityNodeIds:
      acquisition?.snapshot.eligibilityNodeIds ?? loadout.snapshot.resolved.learnedNodeIds,
    learnedNodeIds: loadout.snapshot.resolved.learnedNodeIds,
    enabledNodeIds: loadout.snapshot.configuration.enabledNodeIds,
  };
}

const mapNodes = (nodes: SkillNode[]) => new Map(nodes.map((node) => [node.id, node]));

function closure(nodes: Map<string, SkillNode>, ids: string[]) {
  const result = new Set<string>();
  const add = (id: string) => {
    if (result.has(id)) return;
    const node = nodes.get(id);
    if (!node) return;
    node.prerequisites.forEach(add);
    result.add(id);
  };
  ids.forEach(add);
  return [...result];
}

function kind(node: SkillNode) {
  const active = node.resolution.some((item) => item.kind === 'active-ability');
  const passive = node.resolution.some((item) => item.kind !== 'active-ability');
  return active && passive ? 'mixed' : active ? 'active' : 'passive';
}

export function workbenchNodeState(
  node: SkillNode,
  configuration: SkillConfiguration,
): WorkbenchNodeState {
  if (node.lifecycle !== 'available')
    return { status: 'disabled', reasons: [`lifecycle:${node.lifecycle}`] };
  if (configuration.enabledNodeIds.includes(node.id)) return { status: 'enabled', reasons: [] };
  if (configuration.learnedNodeIds.includes(node.id)) return { status: 'learned', reasons: [] };
  const reasons = [
    ...(configuration.eligibilityNodeIds.includes(node.id) ? [] : ['not-eligible']),
    ...node.prerequisites
      .filter((id) => !configuration.learnedNodeIds.includes(id))
      .map((id) => `missing:${id}`),
  ];
  return { status: reasons.length ? 'locked' : 'eligible', reasons };
}

export function learnNode(
  nodes: SkillNode[],
  configuration: SkillConfiguration,
  nodeId: string,
): SkillConfiguration {
  const node = mapNodes(nodes).get(nodeId);
  if (!node || workbenchNodeState(node, configuration).status !== 'eligible') return configuration;
  return { ...configuration, learnedNodeIds: [...configuration.learnedNodeIds, nodeId] };
}

export function toggleEnabledNode(
  nodes: SkillNode[],
  configuration: SkillConfiguration,
  nodeId: string,
): { configuration: SkillConfiguration; error?: string } {
  const indexed = mapNodes(nodes);
  const node = indexed.get(nodeId);
  if (!node || !configuration.learnedNodeIds.includes(nodeId))
    return { configuration, error: '習得済みの技だけ編成できます。' };
  const enabled = configuration.enabledNodeIds.includes(nodeId)
    ? configuration.enabledNodeIds.filter((id) => id !== nodeId)
    : [...configuration.enabledNodeIds, nodeId];
  const resolved = closure(indexed, enabled).map((id) => indexed.get(id)!);
  if (resolved.some((item) => kind(item) === 'mixed'))
    return { configuration, error: '能動と受動を混在させた技は編成できません。' };
  if (new Set(resolved.map((item) => item.coordinate.path)).size > MAX_ENABLED_SKILL_PATHS)
    return { configuration, error: `編成できる道は最大${MAX_ENABLED_SKILL_PATHS}つです。` };
  if (resolved.filter((item) => kind(item) === 'active').length > MAX_ACTIVE_SKILL_NODES)
    return { configuration, error: `能動技は最大${MAX_ACTIVE_SKILL_NODES}個です。` };
  if (resolved.filter((item) => kind(item) === 'passive').length > MAX_PASSIVE_SKILL_NODES)
    return { configuration, error: `受動技は最大${MAX_PASSIVE_SKILL_NODES}個です。` };
  return { configuration: { ...configuration, enabledNodeIds: enabled } };
}

export function loadoutCounts(nodes: SkillNode[], configuration: SkillConfiguration) {
  const indexed = mapNodes(nodes);
  const resolved = closure(indexed, configuration.enabledNodeIds).map((id) => indexed.get(id)!);
  return {
    paths: new Set(resolved.map((node) => node.coordinate.path)).size,
    active: resolved.filter((node) => kind(node) === 'active').length,
    passive: resolved.filter((node) => kind(node) === 'passive').length,
  };
}
