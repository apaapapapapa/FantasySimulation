import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vite-plus/test';
import { DefinitionDiff } from './DefinitionDiff.tsx';

it('shows structural changes safely and keeps invalid editor input editable', () => {
  const markup = renderToStaticMarkup(
    createElement(DefinitionDiff, { before: { hp: 10 }, text: '{"hp":20}' }),
  );
  expect(markup).toContain('/hp');
  expect(markup).toContain('変更前: 10');
  expect(markup).toContain('変更後: 20');
  const invalid = renderToStaticMarkup(createElement(DefinitionDiff, { before: {}, text: '{' }));
  expect(invalid).toContain('JSONを修正');
  const escaped = renderToStaticMarkup(
    createElement(DefinitionDiff, { before: {}, text: '{"name":"<script>"}' }),
  );
  expect(escaped).not.toContain('<script>');
});
