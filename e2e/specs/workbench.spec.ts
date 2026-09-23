import { test, expect } from '../fixtures.ts';
import { RevisionSchema } from '../../packages/domain/src/spatial/index.ts';

test('draft-revisions', async ({ page }, info) => {
  await page.goto('/');
  const editor = page.getByRole('region', { name: '設定の編集' });
  for (const kind of ['character', 'ability']) {
    await editor.getByLabel('設定の種類').selectOption(kind);
    await editor
      .getByRole('button', { name: kind === 'character' ? / · arcane-archer · / : / · arrow · / })
      .click();
    const original = JSON.parse(await editor.getByLabel('定義JSON').inputValue()) as {
      name: string;
    };
    await editor.getByRole('button', { name: '新規IDで複製' }).click();
    const id = `ui.${kind}.${info.retry}`;
    await editor.getByLabel('設定ID').fill(id);
    await editor
      .getByLabel('定義JSON')
      .fill(JSON.stringify({ ...original, name: `E2E ${kind} 1` }));
    await editor.getByRole('button', { name: '保存して検証' }).focus();
    await page.keyboard.press('Enter');
    await expect(editor.getByRole('status', { name: '編集の状態' })).toHaveText(
      '検証に成功しました',
    );
    await editor.getByRole('button', { name: '新revisionを公開' }).click();
    await expect(editor.getByRole('status', { name: '編集の状態' })).toHaveText(
      'revision 1 を公開しました',
    );
    await editor
      .getByLabel('定義JSON')
      .fill(JSON.stringify({ ...original, name: `E2E ${kind} 2` }));
    await editor.getByRole('button', { name: '保存して検証' }).click();
    await expect(editor.getByRole('button', { name: '新revisionを公開' })).toBeEnabled();
    await editor.getByRole('button', { name: '新revisionを公開' }).click();
    await expect(editor.getByRole('status', { name: '編集の状態' })).toHaveText(
      'revision 2 を公開しました',
    );
    const previous: unknown = await page.evaluate(
      async ({ kind, id }) => (await fetch(`/api/revisions/${kind}/${id}/1`)).json(),
      { kind, id },
    );
    expect(RevisionSchema.parse(previous).definition.name).toBe(`E2E ${kind} 1`);
  }
});

test('draft-errors', async ({ page }) => {
  await page.goto('/');
  const editor = page.getByRole('region', { name: '設定の編集' });
  await editor.getByRole('button', { name: / · arcane-archer · / }).click();
  await editor.getByRole('button', { name: '新規IDで複製' }).click();
  await editor.getByLabel('設定ID').fill('ui.invalid');
  await editor.getByLabel('定義JSON').fill('{}');
  await editor.getByRole('button', { name: '保存して検証' }).click();
  await expect(editor.getByRole('status', { name: '編集の状態' })).toHaveText('検証に失敗しました');
  await expect(editor.getByRole('alert')).toBeVisible();
  await expect(editor.getByRole('button', { name: '新revisionを公開' })).toBeDisabled();
  await page.route('**/api/drafts/*', (route) =>
    route.fulfill({ status: 409, json: { error: 'Draft changed; reload before editing' } }),
  );
  await editor.getByRole('button', { name: '下書きを保存' }).click();
  await expect(editor.getByRole('alert')).toContainText('API 409');
});

test('battle-cancel-retry', async ({ page }) => {
  await page.goto('/');
  const battle = page.getByRole('region', { name: '非同期対戦' });
  await battle.getByLabel('参加者A').selectOption('archer');
  await battle.getByLabel('参加者B').selectOption('guardian');
  await battle.getByLabel('乱数seed').fill('7091');
  await battle.getByRole('button', { name: '対戦を開始' }).click();
  await battle.getByRole('button', { name: '対戦を中止', exact: true }).click();
  await expect(battle.getByRole('status', { name: '対戦の状態' })).toHaveText('中止済み');
  const id = await battle.getByLabel('対戦ID').textContent();
  await battle.getByRole('button', { name: '対戦を再試行', exact: true }).click();
  await expect(battle.getByRole('status', { name: '対戦の状態' })).toHaveText('完了', {
    timeout: 15000,
  });
  await expect(battle.getByLabel('対戦ID')).toHaveText(id!);
  await expect(battle.getByLabel('試行履歴')).toContainText('completed');
  await battle.getByRole('button', { name: '結果のリプレイを見る' }).click();
  await expect(page.getByRole('table', { name: '記録された状態' }).getByRole('row')).toHaveCount(3);
});

test('battle-truncated-result', async ({ page }) => {
  await page.goto('/');
  const battle = page.getByRole('region', { name: '非同期対戦' });
  await battle.getByLabel('参加者A').selectOption('swordsman');
  await battle.getByLabel('参加者B').selectOption('sky-mage');
  await battle.getByLabel('乱数seed').fill('7092');
  await battle.getByText('計算予算', { exact: true }).click();
  await battle.getByLabel('ログ上限bytes').fill('1');
  await battle.getByRole('button', { name: '対戦を開始' }).click();
  await expect(battle.getByLabel('結果の種類')).toHaveText('truncated');
  await battle.getByRole('button', { name: '結果のリプレイを見る' }).click();
  await expect(page.getByLabel('リプレイ結果')).toHaveText('truncated');
  await battle.getByLabel('ログ上限bytes').fill('16000000');
  await battle.getByRole('button', { name: '対戦を再試行', exact: true }).click();
  await expect(battle.getByLabel('結果の種類')).toHaveText(/win|draw/, { timeout: 15000 });
  await battle.getByRole('button', { name: '結果のリプレイを見る' }).click();
  await expect(page.getByRole('table', { name: '記録された状態' }).getByRole('row')).toHaveCount(3);
  await page.getByRole('button', { name: '1step進む' }).click();
  await expect(page.getByLabel('現在のstep')).toHaveText('1');
  await page.route('**/api/battle-results/*', (route) =>
    route.fulfill({ status: 503, json: { error: 'Replay missing; result held' } }),
  );
  await battle.getByRole('button', { name: '状態を再取得' }).click();
  await expect(battle.getByRole('alert')).toContainText('Replay missing');
  await expect(battle.getByLabel('結果の種類')).toHaveCount(0);
});

test('battle-api-error', async ({ page }) => {
  await page.route('**/api/battle-jobs', (route) =>
    route.fulfill({ status: 503, json: { error: 'Worker unavailable' } }),
  );
  await page.goto('/');
  const battle = page.getByRole('region', { name: '非同期対戦' });
  await battle.getByRole('button', { name: '対戦を開始' }).click();
  await expect(battle.getByRole('alert')).toContainText('API 503: Worker unavailable');
  await expect(battle.getByRole('status', { name: '対戦の状態' })).toHaveText('未実行');
});
