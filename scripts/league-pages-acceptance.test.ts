import { expect, it } from 'vite-plus/test';
import { normalViewerUrl, pagesExpectation } from './league-pages-acceptance.ts';

const completion = (change: Record<string, unknown> = {}) => ({
  outcome: { status: 'verified' },
  catalogHash: 'sha256:' + '1'.repeat(64),
  recover: false,
  league: { id: 'official-20-v2', snapshot: 'sha256:' + '2'.repeat(64) },
  ...change,
});
it('opens only the normal viewer URL, never a cache-busting or credentialed variant', () => {
  const viewer = 'https://apaapapapapa.github.io/FantasySimulation/';
  expect(normalViewerUrl(viewer)).toBe(viewer);
  expect(normalViewerUrl('http://127.0.0.1:4173/FantasySimulation/')).toBe(
    'http://127.0.0.1:4173/FantasySimulation/',
  );
  for (const url of [
    viewer + '?v=2',
    viewer + '#/leagues/latest',
    'http://apaapapapapa.github.io/FantasySimulation/',
    'https://user:secret@apaapapapapa.github.io/FantasySimulation/',
    'https://apaapapapapa.github.io/FantasySimulation',
  ])
    expect(() => normalViewerUrl(url)).toThrow('normal viewer URL');
});
it('expects exactly the verified new catalog and league snapshot', () => {
  expect(
    pagesExpectation('https://apaapapapapa.github.io/FantasySimulation/', completion()),
  ).toEqual({
    viewerUrl: 'https://apaapapapapa.github.io/FantasySimulation/',
    catalogHash: 'sha256:' + '1'.repeat(64),
    league: { id: 'official-20-v2', snapshot: 'sha256:' + '2'.repeat(64) },
  });
  for (const change of [
    { outcome: { status: 'planned' } },
    { recover: true },
    { catalogHash: 'current' },
    { league: { id: 'official-20-v2' } },
  ])
    expect(() =>
      pagesExpectation('https://apaapapapapa.github.io/FantasySimulation/', completion(change)),
    ).toThrow('verified new publication');
});
