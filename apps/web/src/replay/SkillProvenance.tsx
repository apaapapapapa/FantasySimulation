import type { ReplayContext } from '@fantasy/domain/spatial';

export function skillProvenance(context: ReplayContext) {
  return context.actors.flatMap(({ participant }) => {
    const receipt = participant.skillLoadout;
    return receipt ? [{ actorId: participant.actorId, ...receipt }] : [];
  });
}

/** Immutable catalog, loadout and resolver identities carried by the replay itself. */
export function SkillProvenance({ context }: { context: ReplayContext }) {
  const rows = skillProvenance(context);
  if (!rows.length) return null;
  return (
    <details className="skill-provenance">
      <summary>技構成の由来</summary>
      <table aria-label="技構成の由来">
        <thead>
          <tr>
            <th>参加者</th>
            <th>character</th>
            <th>catalog</th>
            <th>loadout</th>
            <th>resolver</th>
            <th>resolution</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.actorId}>
              <th>{row.actorId}</th>
              <td>
                {row.character.id} r{row.character.revision}
                <small>{row.character.contentHash}</small>
              </td>
              <td>
                {row.catalog.id} r{row.catalog.revision}
                <small>{row.catalog.contentHash}</small>
              </td>
              <td>
                {row.loadout.id} r{row.loadout.revision}
                <small>{row.loadout.contentHash}</small>
              </td>
              <td>{row.resolverVersion}</td>
              <td>
                <ul>
                  {row.nodeResolutions.map(({ nodeId, resolution }) => (
                    <li key={nodeId}>
                      {nodeId} →{' '}
                      {resolution
                        .map((item) =>
                          item.kind === 'augment'
                            ? `${item.baseAbility.id}@${item.baseAbility.revision}→${item.resolvedAbility.revision}`
                            : `${item.ability.id}@${item.ability.revision}`,
                        )
                        .join(', ')}
                    </li>
                  ))}
                </ul>
                <small>{row.resolutionDigest}</small>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
