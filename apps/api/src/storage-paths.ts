import { CURRENT_ENGINE_VERSION } from '@fantasy/domain/spatial';

export const defaultStoragePaths = {
  databasePath: `./data/${CURRENT_ENGINE_VERSION}/fantasy.sqlite`,
  artifactPath: `./data/${CURRENT_ENGINE_VERSION}/replays`,
};
