import { useEffect, useMemo, useState } from 'react';
import {
  SKILL_DANS,
  SKILL_PATHS,
  SKILL_ZODIACS,
  skillCatalogDigest,
  type SkillCatalog,
  type SkillConfiguration,
  type SkillNode,
} from '@fantasy/domain';
import { errorText } from '../api-client.ts';
import { reference } from '../api-client.ts';
import { sameSkillRevisionRef, skillLoadoutsForCatalog } from './skill-api.ts';
import type {
  SkillCharacter,
  SkillLoadoutHead,
  SkillLoadoutSelection,
  SkillRevisionRef,
  SkillWorkbenchClient,
} from './skill-api.ts';
import {
  learnNode,
  loadoutCounts,
  toggleEnabledNode,
  workbenchNodeState,
} from './skill-workbench-state.ts';

const LABELS = {
  eligible: '習得可能',
  learned: '習得済み',
  enabled: '編成中',
  locked: '未解放',
  disabled: '利用不可',
};
const PATH_OPTIONS = SKILL_PATHS.map(({ id, name }) => ({ value: id, label: name }));
const ZODIAC_OPTIONS = SKILL_ZODIACS.map(({ id, name }) => ({ value: id, label: name }));
const DAN_OPTIONS = SKILL_DANS.map(({ dan, name }) => ({ value: String(dan), label: name }));
const refKey = (value: SkillRevisionRef) => `${value.id}@${value.revision}:${value.contentHash}`;

function FilterOptions({ items }: { items: readonly { value: string; label: string }[] }) {
  return items.map((item) => (
    <option key={item.value} value={item.value}>
      {item.label}
    </option>
  ));
}

export function SkillWorkbench({
  client,
  catalogId = 'skill-catalog-v1',
  catalogVersion = 1,
  onSaved,
}: {
  client: SkillWorkbenchClient;
  catalogId?: string;
  catalogVersion?: number;
  onSaved(value: SkillLoadoutSelection | null): void;
}) {
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const [characters, setCharacters] = useState<SkillCharacter[]>([]);
  const [character, setCharacter] = useState<SkillRevisionRef | null>(null);
  const [saved, setSaved] = useState<SkillLoadoutHead[]>([]);
  const [configuration, setConfiguration] = useState<SkillConfiguration | null>(null);
  const [selectedRevision, setSelectedRevision] = useState<SkillLoadoutHead | null>(null);
  const [path, setPath] = useState(SKILL_PATHS[0].id as string);
  const [zodiac, setZodiac] = useState('all');
  const [dan, setDan] = useState('all');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function hydrate(signal?: AbortSignal, replace = false) {
    const [nextCatalog, nextCharacters, loadouts] = await Promise.all([
      client.getCatalog(catalogId, catalogVersion, signal),
      client.listCharacters(signal),
      client.listLoadouts(signal),
    ]);
    const catalogRef = {
      id: nextCatalog.id,
      revision: nextCatalog.revision,
      contentHash: await skillCatalogDigest(nextCatalog),
    };
    const matchingLoadouts = skillLoadoutsForCatalog(loadouts, catalogRef);
    setCatalog(nextCatalog);
    setCharacters(nextCharacters);
    setSaved(matchingLoadouts);
    if (!configuration || replace) {
      const current = replace
        ? (matchingLoadouts.find((item) => item.id === selectedRevision?.id) ??
          matchingLoadouts[0] ??
          null)
        : (matchingLoadouts[0] ?? null);
      setSelectedRevision(current);
      setCharacter(
        current?.snapshot.character ??
          (character &&
          nextCharacters.some((item) => sameSkillRevisionRef(reference(item), character))
            ? character
            : nextCharacters[0]
              ? reference(nextCharacters[0])
              : null),
      );
      setConfiguration(
        current?.snapshot.configuration ?? {
          schemaVersion: 1,
          id: `loadout-${crypto.randomUUID()}`,
          version: 1,
          catalog: catalogRef,
          eligibilityNodeIds: nextCatalog.nodes
            .filter((node) => node.lifecycle === 'available')
            .map((node) => node.id),
          learnedNodeIds: [],
          enabledNodeIds: [],
        },
      );
      onSaved(current ? { loadout: current.latest, character: current.snapshot.character } : null);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void hydrate(controller.signal, true).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(errorText(cause));
    });
    return () => controller.abort();
  }, [catalogId, catalogVersion]);

  const visible = useMemo(
    () =>
      (catalog?.nodes ?? []).filter(
        (node) =>
          node.coordinate.path === path &&
          (zodiac === 'all' || node.coordinate.zodiac === zodiac) &&
          (dan === 'all' || node.coordinate.dan === Number(dan)),
      ),
    [catalog, path, zodiac, dan],
  );
  const counts = catalog && configuration ? loadoutCounts(catalog.nodes, configuration) : null;

  function choose(savedId: string) {
    const revision = saved.find((item) => `${item.id}:${item.latest.revision}` === savedId) ?? null;
    if (!revision) {
      if (!catalog || !configuration) return;
      setSelectedRevision(null);
      onSaved(null);
      setConfiguration({
        ...configuration,
        id: `loadout-${crypto.randomUUID()}`,
        version: 1,
        eligibilityNodeIds: catalog.nodes
          .filter((node) => node.lifecycle === 'available')
          .map((node) => node.id),
        learnedNodeIds: [],
        enabledNodeIds: [],
      });
      setMessage('新規構成に切り替えました。');
      return;
    }
    setSelectedRevision(revision);
    setConfiguration(revision.snapshot.configuration);
    setCharacter(revision.snapshot.character);
    onSaved({ loadout: revision.latest, character: revision.snapshot.character });
    setMessage(`revision ${revision.latest.revision} を再読込しました。`);
  }

  function operate(node: SkillNode) {
    if (!configuration || !catalog) return;
    const state = workbenchNodeState(node, configuration);
    setError('');
    if (state.status === 'eligible')
      setConfiguration(learnNode(catalog.nodes, configuration, node.id));
    else if (state.status === 'learned' || state.status === 'enabled') {
      const next = toggleEnabledNode(catalog.nodes, configuration, node.id);
      if (next.error) setError(next.error);
      else setConfiguration(next.configuration);
    }
  }

  async function save() {
    if (!configuration) return;
    if (!character) {
      setError('構成を保存するキャラクターを選んでください。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const nextConfiguration = selectedRevision
        ? { ...configuration, version: selectedRevision.version + 1 }
        : configuration;
      const result = selectedRevision
        ? await client.updateLoadout(
            selectedRevision.id,
            selectedRevision.version,
            character,
            nextConfiguration,
          )
        : await client.createLoadout(character, nextConfiguration);
      setSelectedRevision(result);
      setConfiguration(result.snapshot.configuration);
      setSaved((items) => [result, ...items.filter((item) => item.id !== result.id)]);
      onSaved({ loadout: result.latest, character: result.snapshot.character });
      setMessage(`revision ${result.latest.revision} を保存しました。`);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel skill-workbench" aria-labelledby="skill-workbench-heading">
      <h2 id="skill-workbench-heading">技の習得・編成</h2>
      <p>カタログの定義を絞り込み、習得後に戦闘へ持ち込む技を編成します。</p>
      <fieldset disabled={busy || !catalog || !configuration}>
        <div className="skill-filters">
          <label>
            道
            <select value={path} onChange={(event) => setPath(event.target.value)}>
              <FilterOptions items={PATH_OPTIONS} />
            </select>
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
        <label>
          キャラクター
          <select
            disabled={selectedRevision !== null}
            value={character ? refKey(character) : ''}
            onChange={(event) => {
              const selected = characters.find(
                (item) => refKey(reference(item)) === event.target.value,
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
                <option value={refKey(character)}>
                  {character.id} r{character.revision} (saved)
                </option>
              )}
            {characters.map((item) => (
              <option key={refKey(reference(item))} value={refKey(reference(item))}>
                {item.definition.name}・r{item.revision}
              </option>
            ))}
          </select>
        </label>
        <label>
          保存済み構成
          <select
            value={
              selectedRevision ? `${selectedRevision.id}:${selectedRevision.latest.revision}` : ''
            }
            onChange={(event) => choose(event.target.value)}
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
        <p aria-live="polite">
          編成: 道 {counts?.paths ?? 0}/2、能動 {counts?.active ?? 0}/8、受動 {counts?.passive ?? 0}
          /4
        </p>
        <ul className="skill-grid" aria-label="技一覧">
          {visible.map((node) => {
            const state = workbenchNodeState(node, configuration!);
            const unavailable = state.status === 'locked' || state.status === 'disabled';
            return (
              <li key={node.id} data-state={state.status}>
                <button
                  type="button"
                  disabled={unavailable}
                  aria-pressed={state.status === 'enabled'}
                  aria-describedby={`${node.id}-description`}
                  onClick={() => operate(node)}
                >
                  <strong>{node.name}</strong>
                  <span>
                    {LABELS[state.status]}・{node.coordinate.dan}段
                  </span>
                </button>
                <small id={`${node.id}-description`}>
                  {node.description}
                  {state.reasons.length ? `（${state.reasons.join('、')}）` : ''}
                </small>
              </li>
            );
          })}
        </ul>
        <div className="actions">
          <button type="button" className="primary" onClick={() => void save()}>
            構成を保存
          </button>
          <button
            type="button"
            onClick={() =>
              void hydrate(undefined, true).catch((cause) => setError(errorText(cause)))
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
