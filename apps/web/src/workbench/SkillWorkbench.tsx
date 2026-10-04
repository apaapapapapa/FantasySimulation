import { useEffect, useMemo, useRef, useState } from 'react';
import {
  SKILL_DANS,
  SKILL_PATHS,
  SKILL_ZODIACS,
  revisionRefKey,
  skillCatalogDigest,
  type SkillAcquisitionHead,
  type SkillCatalog,
  type SkillConfiguration,
  type SkillNode,
  type SkillPreviewResponse,
} from '@fantasy/domain';
import { errorText, reference } from '../api-client.ts';
import {
  DEFAULT_SKILL_CATALOG,
  createOrRecoverSkillAcquisition,
  sameSkillNodeIds,
  sameSkillRevisionRef,
  skillAcquisitionAdvanced,
  skillLoadoutsForCatalog,
  skillPreviewKey,
  currentSkillPreview,
} from './skill-api.ts';
import type {
  SkillAbility,
  SkillCharacter,
  SkillLoadoutHead,
  SkillLoadoutSelection,
  SkillRevisionRef,
  SkillWorkbenchClient,
} from './skill-api.ts';
import {
  abilitiesForNode,
  filterSkillNodes,
  formatAbilityConstraints,
  formatAbilityCosts,
  workbenchReasonTexts,
  skillPreviewReasonText,
} from './skill-workbench-view.ts';
import {
  learnNode,
  latestSelectionGuard,
  loadoutCounts,
  newSkillConfiguration,
  savedSkillConfiguration,
  toggleEnabledNode,
  workbenchNodeState,
  type WorkbenchStatus,
} from './skill-workbench-state.ts';

const LABELS: Record<WorkbenchStatus, string> = {
  eligible: '習得可能',
  learned: '習得済み',
  enabled: '編成中',
  locked: '未解放',
  disabled: '利用不可',
};
const ACTIONS: Record<WorkbenchStatus, string> = {
  eligible: '習得する',
  learned: '編成する',
  enabled: '編成から外す',
  locked: '選択できません',
  disabled: '選択できません',
};
const ZODIAC_OPTIONS = SKILL_ZODIACS.map(({ id, name }) => ({ value: id, label: name }));
const DAN_OPTIONS = SKILL_DANS.map(({ dan, name }) => ({ value: String(dan), label: name }));
const coordinateKey = (node: SkillNode) => `${node.coordinate.dan}:${node.coordinate.zodiac}`;
const ACQUISITION_ADVANCED_ERROR =
  'The acquisition head advanced after this loadout was saved. Its exact battle revision is still selected, but it cannot be edited as the latest acquisition.';
const RELOAD_ACQUISITION_ERROR = 'Reload the latest acquisition before editing this saved loadout.';

function FilterOptions({ items }: { items: readonly { value: string; label: string }[] }) {
  return items.map((item) => (
    <option key={item.value} value={item.value}>
      {item.label}
    </option>
  ));
}

function resolutionLabel(node: SkillNode) {
  if (!node.resolution.length) return '実行定義なし';
  return node.resolution
    .map((item) => {
      if (item.kind === 'augment')
        return `強化: ${item.baseAbility.id} → ${item.resolvedAbility.id}`;
      return `${item.kind === 'active-ability' ? '発動技' : '常時効果'}: ${item.ability.id}`;
    })
    .join(' / ');
}

function targetLabel(target: SkillAbility['definition']['target']) {
  return target === 'self' ? '自分' : '相手';
}

export function SkillWorkbench({
  client,
  catalogId = DEFAULT_SKILL_CATALOG.id,
  catalogVersion = DEFAULT_SKILL_CATALOG.revision,
  onSaved,
}: {
  client: SkillWorkbenchClient;
  catalogId?: string;
  catalogVersion?: number;
  onSaved(value: SkillLoadoutSelection | null): void;
}) {
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const [abilities, setAbilities] = useState<SkillAbility[]>([]);
  const [characters, setCharacters] = useState<SkillCharacter[]>([]);
  const [character, setCharacter] = useState<SkillRevisionRef | null>(null);
  const [saved, setSaved] = useState<SkillLoadoutHead[]>([]);
  const [configuration, setConfiguration] = useState<SkillConfiguration | null>(null);
  const [selectedRevision, setSelectedRevision] = useState<SkillLoadoutHead | null>(null);
  const [acquisition, setAcquisition] = useState<SkillAcquisitionHead | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [path, setPath] = useState(SKILL_PATHS[0].id as string);
  const [query, setQuery] = useState('');
  const [zodiac, setZodiac] = useState('all');
  const [dan, setDan] = useState('all');
  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const selectionGuard = useRef(latestSelectionGuard()).current;

  const previewGuard = useRef(latestSelectionGuard()).current;
  const [preview, setPreview] = useState<{
    key: string;
    status: 'pending' | 'ready' | 'failed';
    result: SkillPreviewResponse | null;
    error: string;
  }>({ key: '', status: 'pending', result: null, error: '' });
  const previewInput =
    character && configuration
      ? {
          character,
          catalog: configuration.catalog,
          learnedNodeIds: configuration.learnedNodeIds,
          enabledNodeIds: configuration.enabledNodeIds,
        }
      : null;
  const previewKey = previewInput ? skillPreviewKey(previewInput) : '';
  const previewReady = !!previewKey && preview.key === previewKey && preview.status === 'ready';
  const displayConfiguration = configuration
    ? {
        ...configuration,
        eligibilityNodeIds: previewReady ? preview.result!.eligibilityNodeIds : [],
      }
    : null;
  useEffect(() => {
    const attempt = previewGuard.begin(),
      controller = new AbortController();
    setPreview({ key: previewKey, status: 'pending', result: null, error: '' });
    if (previewInput)
      void currentSkillPreview(client, previewInput, attempt, controller.signal)
        .then((result) => {
          if (result) setPreview({ key: previewKey, status: 'ready', result, error: '' });
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted && attempt.isCurrent())
            setPreview({
              key: previewKey,
              status: 'failed',
              result: null,
              error: errorText(cause),
            });
        });
    return () => controller.abort();
  }, [previewKey, client]);

  async function hydrate(signal?: AbortSignal, replace = false) {
    setSelecting(true);
    const attempt = selectionGuard.begin(),
      [nextCatalog, nextAbilities, nextCharacters, loadouts] = await Promise.all([
        client.getCatalog(catalogId, catalogVersion, signal),
        client.listAbilities(signal),
        client.listCharacters(signal),
        client.listLoadouts(signal),
      ]);
    const catalogRef = {
      id: nextCatalog.id,
      revision: nextCatalog.revision,
      contentHash: await skillCatalogDigest(nextCatalog),
    };
    const matchingLoadouts = skillLoadoutsForCatalog(loadouts, catalogRef);
    if (signal?.aborted || !attempt.isCurrent()) return;
    setCatalog(nextCatalog);
    setAbilities(nextAbilities);
    setCharacters(nextCharacters);
    setSaved(matchingLoadouts);
    setSelectedNodeId((current) =>
      current && nextCatalog.nodes.some((node) => node.id === current)
        ? current
        : (nextCatalog.nodes.find(
            (node) => node.coordinate.path === path && node.coordinate.dan === 6,
          )?.id ?? null),
    );
    if (!configuration || replace) {
      const current = replace
        ? (matchingLoadouts.find((item) => item.id === selectedRevision?.id) ?? null)
        : null;
      const currentAcquisition =
        current?.snapshot.configuration.schemaVersion === 2
          ? await client.getAcquisition(current.snapshot.configuration.acquisition.id, signal)
          : null;
      if (signal?.aborted || !attempt.isCurrent()) return;
      if (current) selectSaved(current, currentAcquisition);
      else {
        setSelectedRevision(null);
        setAcquisition(null);
        setCharacter(
          character &&
            nextCharacters.some((item) => sameSkillRevisionRef(reference(item), character))
            ? character
            : nextCharacters[0]
              ? reference(nextCharacters[0])
              : null,
        );
        setConfiguration(newSkillConfiguration(nextCatalog.nodes, catalogRef));
        onSaved(null);
      }
    }
    if (attempt.isCurrent()) setSelecting(false);
  }

  /** Select an exact saved revision; an advanced acquisition keeps it selected but read-only. */
  function selectSaved(loadout: SkillLoadoutHead, latestAcquisition: SkillAcquisitionHead | null) {
    const advanced = skillAcquisitionAdvanced(loadout, latestAcquisition),
      editable = advanced ? null : latestAcquisition;
    setSelectedRevision(loadout);
    setAcquisition(editable);
    setCharacter(loadout.snapshot.character);
    setConfiguration(savedSkillConfiguration(loadout, editable));
    onSaved({ loadout: loadout.latest, character: loadout.snapshot.character });
    if (advanced) setError(ACQUISITION_ADVANCED_ERROR);
    return !advanced;
  }

  useEffect(() => {
    const controller = new AbortController();
    void hydrate(controller.signal, true).catch((cause: unknown) => {
      if (!controller.signal.aborted) {
        setSelecting(false);
        setError(errorText(cause));
      }
    });
    return () => controller.abort();
  }, [catalogId, catalogVersion]);

  const pathNodes = useMemo(
    () => (catalog?.nodes ?? []).filter((node) => node.coordinate.path === path),
    [catalog, path],
  );
  const nodesByCoordinate = useMemo(
    () => new Map(pathNodes.map((node) => [coordinateKey(node), node])),
    [pathNodes],
  );
  const visible = useMemo(
    () => filterSkillNodes(catalog?.nodes ?? [], { query, path, zodiac, dan }),
    [catalog, query, path, zodiac, dan],
  );
  const visibleIds = useMemo(() => new Set(visible.map((node) => node.id)), [visible]);
  const selectedCandidate = catalog?.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedNode =
    selectedCandidate && visibleIds.has(selectedCandidate.id) ? selectedCandidate : null;
  const selectedPath = SKILL_PATHS.find((item) => item.id === path)!;
  const counts = catalog && configuration ? loadoutCounts(catalog.nodes, configuration) : null;
  const editingBlocked = selectedRevision?.schemaVersion === 2 && !acquisition;

  function selectPath(nextPath: string) {
    setPath(nextPath);
    const nextNode = catalog?.nodes.find(
      (node) => node.coordinate.path === nextPath && node.coordinate.dan === 6,
    );
    setSelectedNodeId(nextNode?.id ?? null);
  }

  async function choose(savedId: string) {
    const attempt = selectionGuard.begin(),
      revision = saved.find((item) => `${item.id}:${item.latest.revision}` === savedId) ?? null;
    if (!revision) {
      if (!catalog || !configuration) return;
      if (attempt.isCurrent()) setSelecting(false);
      setSelectedRevision(null);
      setAcquisition(null);
      onSaved(null);
      setConfiguration(newSkillConfiguration(catalog.nodes, configuration.catalog));
      setMessage('新規構成に切り替えました。');
      return;
    }
    setError('');
    setSelecting(true);
    let nextAcquisition: SkillAcquisitionHead | null = null;
    try {
      if (revision.snapshot.configuration.schemaVersion === 2) {
        nextAcquisition = await client.getAcquisition(
          revision.snapshot.configuration.acquisition.id,
        );
        if (!attempt.isCurrent()) return;
      }
    } catch (cause) {
      if (attempt.isCurrent()) setSelecting(false);
      throw cause;
    }
    const editable = selectSaved(revision, nextAcquisition);
    if (attempt.isCurrent()) setSelecting(false);
    if (editable) setMessage(`revision ${revision.latest.revision} を再読込しました。`);
  }

  function operate(node: SkillNode) {
    if (!configuration || !catalog || !displayConfiguration || !previewReady) return;
    if (editingBlocked) {
      setError(RELOAD_ACQUISITION_ERROR);
      return;
    }
    const state = workbenchNodeState(node, displayConfiguration);
    setError('');
    if (state.status === 'eligible')
      setConfiguration(learnNode(catalog.nodes, displayConfiguration, node.id));
    else if (state.status === 'learned' || state.status === 'enabled') {
      const next = toggleEnabledNode(catalog.nodes, displayConfiguration, node.id);
      if (next.error) setError(next.error);
      else setConfiguration(next.configuration);
    }
  }

  async function save() {
    if (!configuration || !previewReady || !preview.result?.canSave) return;
    if (!character) {
      setError('構成を保存するキャラクターを選んでください。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (editingBlocked) throw new Error(RELOAD_ACQUISITION_ERROR);
      const acquisitionMatches =
        acquisition &&
        sameSkillRevisionRef(acquisition.snapshot.character, character) &&
        sameSkillRevisionRef(acquisition.snapshot.catalog, configuration.catalog) &&
        sameSkillNodeIds(acquisition.snapshot.learnedNodeIds, configuration.learnedNodeIds);
      const nextAcquisition = acquisitionMatches
        ? acquisition
        : acquisition
          ? await client.updateAcquisition(acquisition.id, acquisition.version, {
              schemaVersion: 1,
              id: acquisition.id,
              version: acquisition.version + 1,
              character,
              catalog: configuration.catalog,
              learnedNodeIds: configuration.learnedNodeIds,
            })
          : await createOrRecoverSkillAcquisition(client, {
              schemaVersion: 1,
              id: `${configuration.id}.acquisition`,
              version: 1,
              character,
              catalog: configuration.catalog,
              learnedNodeIds: configuration.learnedNodeIds,
            });
      setAcquisition(nextAcquisition);
      const nextConfiguration = {
        schemaVersion: 2 as const,
        id: configuration.id,
        version: selectedRevision ? selectedRevision.version + 1 : 1,
        catalog: configuration.catalog,
        acquisition: nextAcquisition.latest,
        enabledNodeIds: configuration.enabledNodeIds,
      };
      const result = selectedRevision
        ? await client.updateLoadout(
            selectedRevision.id,
            selectedRevision.version,
            character,
            nextConfiguration,
          )
        : await client.createLoadout(character, nextConfiguration);
      setSelectedRevision(result);
      setConfiguration(savedSkillConfiguration(result, nextAcquisition));
      setSaved((items) => [result, ...items.filter((item) => item.id !== result.id)]);
      onSaved({ loadout: result.latest, character: result.snapshot.character });
      setMessage(`revision ${result.latest.revision} を保存しました。下の対戦画面で使用できます。`);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  const detailState =
    selectedNode && displayConfiguration
      ? workbenchNodeState(selectedNode, displayConfiguration)
      : null;
  const detailReasons =
    detailState && catalog
      ? [
          ...new Set([
            ...workbenchReasonTexts(detailState, catalog.nodes),
            ...(previewReady
              ? preview
                  .result!.nodeReasons.filter(
                    (reason) => 'nodeId' in reason && reason.nodeId === selectedNode?.id,
                  )
                  .map((reason) => skillPreviewReasonText(reason, catalog.nodes))
              : []),
          ]),
        ]
      : [];
  const detailAbilities = selectedNode ? abilitiesForNode(selectedNode, abilities) : [];

  return (
    <section className="panel skill-workbench" aria-labelledby="skill-workbench-heading">
      <h2 id="skill-workbench-heading">技の習得・編成</h2>
      <p className="local-note">
        <strong>ローカル専用:</strong>{' '}
        この画面は端末内APIへ保存する開発用WorkBenchです。公開Pagesからの編集はできません。
      </p>
      <p>
        道を選び、六段から初段・子から亥の72枠を確認します。保存した構成は下の対戦へ渡り、完了後に保存リプレイを開けます。
      </p>
      <p role="status" aria-label="習得可否の確認">
        {previewReady
          ? 'サーバーで習得・編成条件を確認しました。保存時にも再検証します。'
          : preview.key === previewKey && preview.status === 'failed'
            ? `習得可否を確認できません: ${preview.error}`
            : '習得可否を確認中です。'}
      </p>
      {previewReady && preview.result!.reasons.length > 0 && (
        <ul aria-label="保存できない理由">
          {preview.result!.reasons.map((reason, index) => (
            <li key={index}>{skillPreviewReasonText(reason, catalog?.nodes ?? [])}</li>
          ))}
        </ul>
      )}
      {previewReady && preview.result!.reasonsTruncated && (
        <p>理由が表示上限を超えています。構成を絞って再確認してください。</p>
      )}
      <fieldset disabled={busy || selecting || !catalog || !configuration}>
        <nav className="skill-paths" aria-label="道一覧">
          {SKILL_PATHS.map((item) => {
            const nodes = catalog?.nodes.filter((node) => node.coordinate.path === item.id) ?? [];
            const available = nodes.filter((node) => node.lifecycle === 'available').length;
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={path === item.id}
                onClick={() => selectPath(item.id)}
              >
                <strong>{item.name}</strong>
                <span>{item.role}</span>
                <small>{available}/72 利用可能</small>
              </button>
            );
          })}
        </nav>

        <div className="skill-filters" role="search" aria-label="技を検索">
          <label>
            名前・効果・道を検索
            <input
              type="search"
              value={query}
              placeholder="例: 防護、盾道、shield"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label>
            十二支
            <select value={zodiac} onChange={(event) => setZodiac(event.target.value)}>
              <option value="all">すべて</option>
              <FilterOptions items={ZODIAC_OPTIONS} />
            </select>
          </label>
          <label>
            段
            <select value={dan} onChange={(event) => setDan(event.target.value)}>
              <option value="all">すべて</option>
              <FilterOptions items={DAN_OPTIONS} />
            </select>
          </label>
        </div>
        <p role="status" aria-label="検索結果">
          {selectedPath.name}: {visible.length}/72 枠が検索条件に一致
        </p>
        <p className="muted">
          非該当の枠は座標だけを残して内容を隠し、操作できません。条件を解除すると再び選べます。
        </p>

        <div className="skill-matrix-scroll" tabIndex={0} aria-label={`${selectedPath.name} 72枠`}>
          <table className="skill-matrix">
            <caption>
              {selectedPath.name} — {selectedPath.role}
            </caption>
            <thead>
              <tr>
                <th scope="col">段</th>
                {SKILL_ZODIACS.map((item) => (
                  <th scope="col" key={item.id} title={item.tendency}>
                    {item.name}
                    <small>{item.tendency}</small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...SKILL_DANS].reverse().map((rank) => (
                <tr key={rank.dan}>
                  <th scope="row">
                    {rank.name}
                    <small>{rank.deepening}</small>
                  </th>
                  {SKILL_ZODIACS.map((animal) => {
                    const node = nodesByCoordinate.get(`${rank.dan}:${animal.id}`);
                    if (!node) return <td key={animal.id}>欠落</td>;
                    const state = workbenchNodeState(node, displayConfiguration!);
                    const matches = visibleIds.has(node.id);
                    return (
                      <td key={animal.id} data-state={state.status} data-match={matches}>
                        <button
                          type="button"
                          aria-pressed={selectedNodeId === node.id}
                          aria-disabled={!matches}
                          aria-hidden={!matches}
                          disabled={!matches}
                          tabIndex={matches ? 0 : -1}
                          onClick={() => setSelectedNodeId(node.id)}
                        >
                          <strong>{node.name}</strong>
                          <span>{LABELS[state.status]}</span>
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {selectedNode && detailState && (
          <article className="skill-detail" aria-labelledby="skill-detail-heading">
            <header>
              <div>
                <p className="eyebrow">
                  {SKILL_PATHS.find((item) => item.id === selectedNode.coordinate.path)?.name}・
                  {SKILL_ZODIACS.find((item) => item.id === selectedNode.coordinate.zodiac)?.name}・
                  {SKILL_DANS.find((item) => item.dan === selectedNode.coordinate.dan)?.name}
                </p>
                <h3 id="skill-detail-heading">{selectedNode.name}</h3>
              </div>
              <span className="skill-state" data-state={detailState.status}>
                {LABELS[detailState.status]}
              </span>
            </header>
            <dl>
              <div>
                <dt>効果</dt>
                <dd>{selectedNode.description}</dd>
              </div>
              <div>
                <dt>前提</dt>
                <dd>
                  {selectedNode.prerequisites.length
                    ? selectedNode.prerequisites
                        .map(
                          (id) =>
                            catalog?.nodes.find((candidate) => candidate.id === id)?.name ?? id,
                        )
                        .join(' / ')
                    : 'なし'}
                </dd>
              </div>
              <div>
                <dt>対象</dt>
                <dd>
                  {detailAbilities.length
                    ? detailAbilities
                        .map(({ reference, ability }) =>
                          ability
                            ? `${ability.definition.name}: ${targetLabel(ability.definition.target)}`
                            : `${reference.id}: 参照定義を取得できません`,
                        )
                        .join(' / ')
                    : '実行定義なし（戦闘対象なし）'}
                </dd>
              </div>
              <div>
                <dt>消耗</dt>
                <dd>
                  {detailAbilities.length
                    ? detailAbilities
                        .map(({ reference, ability }) =>
                          ability
                            ? `${ability.definition.name}: ${formatAbilityCosts(ability)}`
                            : `${reference.id}: 不明`,
                        )
                        .join(' / ')
                    : '実行定義なし'}
                </dd>
              </div>
              <div>
                <dt>制約</dt>
                <dd>
                  {[
                    ...(selectedNode.weaponTags?.length
                      ? [`武器 ${selectedNode.weaponTags.join(', ')}`]
                      : []),
                    ...(selectedNode.deepening.conditionOrTradeoff
                      ? [selectedNode.deepening.conditionOrTradeoff]
                      : []),
                    ...detailAbilities.flatMap(({ ability }) =>
                      ability ? [formatAbilityConstraints(ability)] : [],
                    ),
                  ].join(' / ') || 'カタログ上の追加制約なし'}
                </dd>
              </div>
              <div>
                <dt>深化</dt>
                <dd>
                  {selectedNode.deepening.explanation}
                  {selectedNode.deepening.retainsLowerUse ? '（下位段の用途を維持）' : ''}
                </dd>
              </div>
              <div>
                <dt>実行対応</dt>
                <dd>{resolutionLabel(selectedNode)}</dd>
              </div>
            </dl>
            {detailReasons.length > 0 && (
              <div className="skill-blockers" role="note" aria-label="習得・編成の確認事項">
                <strong>習得・編成の確認事項</strong>
                <ul>
                  {detailReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            )}
            <button
              type="button"
              className="skill-node-action"
              disabled={
                !previewReady ||
                editingBlocked ||
                detailState.status === 'locked' ||
                detailState.status === 'disabled'
              }
              onClick={() => operate(selectedNode)}
            >
              {ACTIONS[detailState.status]}
            </button>
          </article>
        )}

        <div className="skill-loadout-controls">
          <label>
            キャラクター
            <select
              disabled={selectedRevision !== null}
              value={character ? revisionRefKey(character) : ''}
              onChange={(event) => {
                const selected = characters.find(
                  (item) => revisionRefKey(reference(item)) === event.target.value,
                );
                if (selected) {
                  setCharacter(reference(selected));
                  if (selectedRevision) {
                    setSelectedRevision(null);
                    onSaved(null);
                  }
                }
              }}
            >
              {character &&
                !characters.some((item) => sameSkillRevisionRef(reference(item), character)) && (
                  <option value={revisionRefKey(character)}>
                    {character.id} r{character.revision} (saved)
                  </option>
                )}
              {characters.map((item) => (
                <option
                  key={revisionRefKey(reference(item))}
                  value={revisionRefKey(reference(item))}
                >
                  {item.definition.name}・r{item.revision}
                </option>
              ))}
            </select>
          </label>
          <label>
            保存済み構成
            <select
              disabled={selecting}
              aria-busy={selecting}
              value={
                selectedRevision ? `${selectedRevision.id}:${selectedRevision.latest.revision}` : ''
              }
              onChange={(event) =>
                void choose(event.target.value).catch((cause) => setError(errorText(cause)))
              }
            >
              <option value="">新規構成</option>
              {saved.map((item) => (
                <option
                  key={`${item.id}:${item.latest.revision}`}
                  value={`${item.id}:${item.latest.revision}`}
                >
                  {item.id}・revision {item.latest.revision}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p aria-live="polite">
          編成: 道 {counts?.paths ?? 0}/2、発動技 {counts?.active ?? 0}/8、常時効果{' '}
          {counts?.passive ?? 0}/4
        </p>
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={!previewReady || !preview.result?.canSave || editingBlocked}
            onClick={() => void save()}
          >
            構成を保存
          </button>
          <button
            type="button"
            onClick={() =>
              void hydrate(undefined, true).catch((cause) => {
                setSelecting(false);
                setError(errorText(cause));
              })
            }
          >
            サーバーから再読込
          </button>
        </div>
      </fieldset>
      {message && (
        <p role="status" className="message">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="message error">
          {error}
        </p>
      )}
    </section>
  );
}
