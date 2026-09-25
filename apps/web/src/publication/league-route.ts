import { IdSchema, publicHashName } from '@fantasy/domain/spatial';

export interface LeagueRoute {
  snapshot: string;
  character: string | null;
  opponent: string | null;
  page: number;
  slot: string | null;
}
export function leagueLink(
  snapshot: string,
  character?: string | null,
  opponent?: string | null,
  page = 0,
  slot?: string | null,
) {
  if (
    !Number.isInteger(page) ||
    page < 0 ||
    page > 6 ||
    (opponent && !character) ||
    (slot && !opponent)
  )
    throw new Error('Invalid league route');
  return `#/leagues/${publicHashName(snapshot)}${character ? `/characters/${IdSchema.parse(character)}` : ''}${opponent ? `/opponents/${IdSchema.parse(opponent)}/pages/${page}` : ''}${slot ? `/matches/${publicHashName(slot)}` : ''}`;
}
export function readLeagueRoute(hash: string): LeagueRoute | null {
  const match =
    /^#\/leagues\/([0-9a-f]{64})(?:\/characters\/([a-z0-9][a-z0-9._-]{0,63})(?:\/opponents\/([a-z0-9][a-z0-9._-]{0,63})\/pages\/([0-6])(?:\/matches\/([0-9a-f]{64}))?)?)?$/.exec(
      hash,
    );
  return match
    ? {
        snapshot: `sha256:${match[1]}`,
        character: match[2] ?? null,
        opponent: match[3] ?? null,
        page: Number(match[4] ?? 0),
        slot: match[5] ? `sha256:${match[5]}` : null,
      }
    : null;
}
