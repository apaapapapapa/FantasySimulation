import { revisionReference, type LeagueDefinition } from '@fantasy/domain/spatial';
import { sealRevision } from '@fantasy/engine/spatial';
import { leagueFixture } from '@fantasy/samples/testing';

export { leagueEstimate } from '@fantasy/samples/testing';
export const leagueInput = (count = 2): Promise<LeagueDefinition> => leagueFixture(count, 1);
/** A fresh league whose first character name is private text that must never be published. */
export async function privateLeagueInput() {
  const input = await leagueInput();
  const character = input.revisions.find(
    (revision) => revision.kind === 'character' && revision.id === input.characters[0]!.id,
  );
  if (!character || character.kind !== 'character') throw new Error('Missing fixture character');
  const privateName = await sealRevision('character', character.id, character.revision, {
    ...character.definition,
    name: '/private/profile',
  });
  input.revisions = input.revisions.map((revision) =>
    revision === character ? privateName : revision,
  );
  input.characters[0] = revisionReference(privateName);
  return input;
}
