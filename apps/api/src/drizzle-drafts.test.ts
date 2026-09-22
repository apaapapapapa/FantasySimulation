import { describe, expect, it } from 'vite-plus/test';
import { openStore } from './store.ts';

describe('Drizzle draft storage invariants', () => {
  it.each([
    ['kind', 1, 'unknown'],
    ['version', 3, 0],
    ['definition', 4, '{'],
    ['published reference', 5, '{'],
    ['base reference', 8, '{'],
  ] as const)('rejects invalid %s at the database boundary', (_, position, invalid) => {
    const store = openStore(':memory:');
    try {
      const values: (string | number | null)[] = [
        'draft', 'character', 'definition', 1, '{}', null, 'now', 'now', null,
      ];
      values[position] = invalid;
      expect(() =>
        store.db.prepare('INSERT INTO definition_drafts VALUES(?,?,?,?,?,?,?,?,?)').run(...values),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      store.close();
    }
  });

  it('rolls back ORM writes made by store methods when the enclosing transaction fails', () => {
    const store = openStore(':memory:');
    try {
      let draftId = '';
      expect(() =>
        store.transaction(() => {
          const draft = store.createDraft({
            kind: 'character', definitionId: 'new-character', base: null, definition: {},
          });
          draftId = draft.id;
          store.patchDraft(draft.id, draft.version, { name: 'not committed' });
          throw new Error('deliberate transaction failure');
        }),
      ).toThrow('deliberate transaction failure');
      expect(draftId).not.toBe('');
      expect(store.getDraft(draftId)).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
