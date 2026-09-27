import { expect, it, vi } from 'vite-plus/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as artifacts from '@fantasy/api/artifacts';
import { withReplayDirectory } from '@fantasy/api/testing';
import { leaguePublicationFixture } from '../../test-support/leagues.ts';
import { exportLeague } from '../league/league-export.ts';
import { localPublicationGraph } from './publication-graph.ts';

it.each(['success', 'failure', 'cancel'] as const)(
  'bounds durable writes, drains admitted work and commits the pointer last: %s',
  async (mode) => {
    await withReplayDirectory(async (root) => {
      const fixture = await leaguePublicationFixture(join(root, 'input'));
      const target = join(root, 'public');
      await exportLeague(fixture.plan, fixture.partitions, [], target);
      const pointer = join(target, 'catalog/current.json');
      const before = await readFile(pointer);
      const gate = Promise.withResolvers<void>();
      const original = artifacts.publishImmutableFile;
      const controller = new AbortController();
      let active = 0, maximum = 0, admitted = 0, settled = false;
      const write = vi.spyOn(artifacts, 'publishImmutableFile').mockImplementation(async (path, bytes) => {
        const ordinal = admitted++;
        active++;
        maximum = Math.max(maximum, active);
        try {
          await gate.promise;
          if (mode === 'failure' && ordinal === 0) throw new Error('Injected durable write failure');
          await original(path, bytes);
        } finally {
          active--;
        }
      });
      const pending = exportLeague(
        fixture.plan, fixture.partitions, fixture.completed, target, undefined,
        { signal: controller.signal },
      ).then(
        (value) => { settled = true; return { value, error: null }; },
        (error: unknown) => { settled = true; return { value: null, error }; },
      );
      try {
        await vi.waitFor(() => expect(active).toBe(4), { timeout: 10000 });
        expect(await readFile(pointer)).toEqual(before);
        expect(settled).toBe(false);
        if (mode === 'cancel') controller.abort();
        gate.resolve();
        const outcome = await pending;
        expect(active).toBe(0);
        expect(maximum).toBe(4);
        if (mode === 'success') {
          expect(outcome.error).toBeNull();
          expect(outcome.value).toMatchObject({ status: 'formal', planned: 4, resolved: 4 });
          expect(await readFile(pointer)).not.toEqual(before);
          await expect(localPublicationGraph(target)).resolves.toBeDefined();
        } else {
          expect(outcome.error).toBeInstanceOf(Error);
          expect(admitted).toBe(4);
          expect(await readFile(pointer)).toEqual(before);
        }
      } finally {
        gate.resolve();
        await pending;
        write.mockRestore();
      }
    });
  },
  30000,
);
