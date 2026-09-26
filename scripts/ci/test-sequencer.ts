import { relative } from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vite-plus/test/node';
import { heaviestFirst } from './test-plan.ts';

/** Vitest's own order, except that files with a known CI weight start first. */
export class WeightedSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const root = this.ctx.config.root;
    return heaviestFirst(await super.sort(files), (spec) =>
      relative(root, spec.moduleId).replaceAll('\\', '/'),
    );
  }
}
