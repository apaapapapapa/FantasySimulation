import { IdSchema, publicHashName } from '@fantasy/domain/spatial';
import { readStep, STEP_PATTERN, stepSuffix } from './match-route.ts';

export interface LeagueRoute {
  snapshot: string;
  character: string | null;
  opponent: string | null;
  page: number;
  slot: string | null;
  step: number | null;
}
export function leagueLink(
  snapshot: string,
  character?: string | null,
  opponent?: string | null,
  page = 0,
  slot?: string | null,
  step?: number | null,
) {
  if (
    !Number.isInteger(page) ||
    page < 0 ||
    page > 6 ||
    (opponent && !character) ||
    (slot && !opponent) ||
    (step != null && !slot)
  )
    throw new Error('Invalid league route');
  return `#/leagues/${publicHashName(snapshot)}${character ? `/characters/${IdSchema.parse(character)}` : ''}${opponent ? `/opponents/${IdSchema.parse(opponent)}/pages/${page}` : ''}${slot ? `/matches/${publicHashName(slot)}` : ''}${stepSuffix(step)}`;
}
export function readLeagueRoute(hash: string): LeagueRoute | null {
  const match = new RegExp(
    `^#\\/leagues\\/([0-9a-f]{64})(?:\\/characters\\/([a-z0-9][a-z0-9._-]{0,63})(?:\\/opponents\\/([a-z0-9][a-z0-9._-]{0,63})\\/pages\\/([0-6])(?:\\/matches\\/([0-9a-f]{64})${STEP_PATTERN})?)?)?$`,
  ).exec(hash);
  const step = readStep(match?.[6]);
  return match && step !== undefined
    ? {
        snapshot: `sha256:${match[1]}`,
        character: match[2] ?? null,
        opponent: match[3] ?? null,
        page: Number(match[4] ?? 0),
        slot: match[5] ? `sha256:${match[5]}` : null,
        step,
      }
    : null;
}
