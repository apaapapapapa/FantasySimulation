import { type LeagueDefinition } from '@fantasy/domain/spatial';
import { leagueFixture } from '@fantasy/samples/testing';

export { leagueEstimate } from '@fantasy/samples/testing';
export const leagueInput = (count = 2): Promise<LeagueDefinition> => leagueFixture(count, 1);
