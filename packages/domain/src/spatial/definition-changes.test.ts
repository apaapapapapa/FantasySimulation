import { expect, it } from 'vite-plus/test';
import { definitionChanges } from './definition-changes.ts';

it('reports values, additions and removals without mistaking formatting for edits', () => {
  expect(definitionChanges({ hp: 10, mp: 2 }, { mp: 2, hp: 10 })).toEqual({
    changes: [],
    truncated: false,
  });
  const diff = definitionChanges({ stats: { hp: 10, mp: 2 } }, { stats: { hp: 20, armor: 0 } });
  expect(diff).toEqual({
    changes: [
      { path: '/stats/armor', kind: 'add', after: '0' },
      { path: '/stats/hp', kind: 'replace', before: '10', after: '20' },
      { path: '/stats/mp', kind: 'remove', before: '2' },
    ],
    truncated: false,
  });
});

it('escapes paths, preserves array ordering and reports incomplete differences explicitly', () => {
  expect(definitionChanges({ 'a/b~': [1, 2] }, { 'a/b~': [2, 1] }, 1)).toEqual({
    changes: [{ path: '/a~1b~0/0', kind: 'replace', before: '1', after: '2' }],
    truncated: true,
  });
  expect(definitionChanges({ value: null }, {})).toEqual({
    changes: [{ path: '/value', kind: 'remove', before: 'null' }],
    truncated: false,
  });
  expect(() => definitionChanges({}, { invalid: undefined })).toThrow();
});
