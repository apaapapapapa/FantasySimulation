import {
  inspectSkillEnabledNodes,
  skillAvailabilityReason,
  skillEnabledLearningReasons,
  skillNodeDecision,
  skillPrerequisiteClosure,
  SkillSelectionError,
  type SkillSelectionReason,
  type AnySkillLoadoutHead,
  type SkillAcquisitionHead,
  type SkillConfiguration,
  type SkillNode,
} from '@fantasy/domain';

export type WorkbenchStatus = 'eligible' | 'learned' | 'enabled' | 'locked' | 'disabled';
export type WorkbenchNodeState = { status: WorkbenchStatus; reasons: SkillSelectionReason[] };

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

export function workbenchNodeState(
  node: SkillNode,
  configuration: SkillConfiguration,
): WorkbenchNodeState {
  const decision = skillNodeDecision(node, {
    eligible: new Set(configuration.eligibilityNodeIds),
    learned: new Set(configuration.learnedNodeIds),
    enabled: new Set(configuration.enabledNodeIds),
  });
  return {
    status:
      decision.status === 'retired' || decision.status === 'unsupported'
        ? 'disabled'
        : decision.status === 'learnable'
          ? 'eligible'
          : decision.status,
    reasons: decision.reasons,
  };
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
  let resolved: SkillNode[];
  try {
    resolved = skillPrerequisiteClosure(nodes, enabled).map((id) => indexed.get(id)!);
  } catch (error) {
    if (error instanceof SkillSelectionError)
      return { configuration, error: selectionErrorText(error.reason) };
    throw error;
  }
  const unlearned = skillEnabledLearningReasons(
    resolved.map((item) => item.id),
    new Set(configuration.learnedNodeIds),
  )[0];
  if (unlearned) return { configuration, error: selectionErrorText(unlearned) };
  const unavailable = resolved.map(skillAvailabilityReason).find((reason) => reason !== undefined);
  if (unavailable) return { configuration, error: selectionErrorText(unavailable) };
  const reason = inspectSkillEnabledNodes(resolved).reasons[0];
  if (reason) return { configuration, error: selectionErrorText(reason) };
  return { configuration: { ...configuration, enabledNodeIds: enabled } };
}

export function loadoutCounts(nodes: SkillNode[], configuration: SkillConfiguration) {
  const indexed = mapNodes(nodes);
  const resolved = skillPrerequisiteClosure(nodes, configuration.enabledNodeIds).map((id) =>
    indexed.get(id)!,
  );
  return inspectSkillEnabledNodes(resolved).counts;
}

function selectionErrorText(reason: SkillSelectionReason) {
  switch (reason.code) {
    case 'enabled-path-limit':
      return `編成できる道は最大${reason.maximum}つです。`;
    case 'active-node-limit':
      return `能動技は最大${reason.maximum}個です。`;
    case 'passive-node-limit':
      return `受動技は最大${reason.maximum}個です。`;
    case 'mixed-resolution-kind':
      return '能動と受動を混在させた技は編成できません。';
    case 'enabled-node-not-learned':
      return '前提を含む習得済みの技だけ編成できます。';
    case 'unavailable-node':
      return '利用可能として公開された技だけ編成できます。';
    default:
      return '技の参照または前提に不整合があるため編成できません。';
  }
}
