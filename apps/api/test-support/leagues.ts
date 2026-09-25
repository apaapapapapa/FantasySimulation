import { type LeagueDefinition, type LeagueEstimateInput } from '@fantasy/domain/spatial';
import { leagueFixture } from '@fantasy/samples/testing';

export const leagueEstimate: LeagueEstimateInput = {
  matchesPerPlan: 128,
  estimatedMsPerMatch: 2000,
  estimatedBytesPerMatch: 250000,
  estimatedFilesPerMatch: 10,
  retainedBytes: 0,
  retainedFiles: 0,
  maxReadRequests: 10000000,
  maxWriteRequests: 1000000,
  usedReadRequests: 0,
  usedWriteRequests: 0,
};
export const leagueInput = (count = 2): Promise<LeagueDefinition> => leagueFixture(count, 1);
