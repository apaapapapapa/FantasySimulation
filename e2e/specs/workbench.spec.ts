import { test, expect } from '../fixtures.ts';
import { RevisionSchema } from '@fantasy/domain/spatial';

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

test('draft-resume-tall-character', async ({ page }, info) => {
  await page.goto('/');
  const editor = page.getByRole('region', { name: '設定の編集' });
  await editor.getByRole('button', { name: / · arcane-archer · / }).click();
  const original = JSON.parse(await editor.getByLabel('定義JSON').inputValue()) as {
    body: { heightMm: number };
  };
  const definition = { ...original, body: { ...original.body, heightMm: 6000 } };
  await editor.getByRole('button', { name: '新規IDで複製' }).click();
  const id = `ui.tall.${info.retry}`;
  await editor.getByLabel('設定ID').fill(id);
  await editor.getByLabel('定義JSON').fill(JSON.stringify(definition));
  await editor.getByRole('button', { name: '下書きを保存' }).click();
  const saved = editor.getByLabel('保存済み下書きID');
  await expect(saved).toBeVisible();
  const draftId = (await saved.textContent())!;
  await page.reload();
  await editor.getByText('保存した下書きを再開', { exact: true }).click();
  await editor.getByRole('button', { name: draftId, exact: true }).click();
  await expect(editor.getByLabel('設定ID')).toHaveValue(id);
  expect(JSON.parse(await editor.getByLabel('定義JSON').inputValue())).toEqual(definition);
  await editor.getByLabel('設定の種類').selectOption('ability');
  await editor.getByLabel('再開する下書きID').fill(draftId);
  await editor.getByRole('button', { name: 'IDから再開' }).click();
  await expect(editor.getByLabel('設定の種類')).toHaveValue('character');
  await editor.getByRole('button', { name: '保存して検証' }).click();
  await expect(editor.getByRole('button', { name: '新revisionを公開' })).toBeEnabled();
  await expect(saved).toHaveText(draftId);
  await editor.getByRole('button', { name: '新revisionを公開' }).click();
  await expect(editor.getByRole('status', { name: '編集の状態' })).toHaveText(
    'revision 1 を公開しました',
  );
  const battle = page.getByRole('region', { name: '非同期対戦' });
  await battle.getByLabel('参加者A').selectOption(id);
  await battle.getByText('計算予算', { exact: true }).click();
  await battle.getByLabel('ログ上限bytes').fill('1');
  await battle.getByText('開始位置を調整', { exact: true }).click();
  const positions = battle.getByLabel('開始位置JSON（A・Bの順、mm）');
  await positions.fill('[{"x":1000000,"y":3020,"z":0},{"x":4000,"y":1200,"z":0}]');
  await battle.getByRole('button', { name: '対戦を開始' }).click();
  await expect(battle.getByRole('alert')).toContainText('Spawn body exceeds arena bounds');
  await positions.fill('[{"x":0,"y":3020,"z":-4000},{"x":0,"y":3020,"z":4000}]');
  const submission = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/battle-jobs',
  );
  await battle.getByRole('button', { name: '対戦を開始' }).click();
  expect(
    (await submission).postDataJSON().spec.participants.map((p: { facing: unknown }) => p.facing),
  ).toEqual([
    { x: 0, y: 0, z: 1000 },
    { x: 0, y: 0, z: -1000 },
  ]);
  await expect(battle.getByLabel('結果の種類')).toHaveText('truncated');
  await expect(battle.getByRole('alert')).toHaveCount(0);
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
  const id = await battle.getByLabel('対戦ID', { exact: true }).textContent();
  await battle.getByRole('button', { name: '対戦を再試行', exact: true }).click();
  await expect(battle.getByRole('status', { name: '対戦の状態' })).toHaveText('完了', {
    timeout: 15000,
  });
  await expect(battle.getByLabel('対戦ID', { exact: true })).toHaveText(id!);
  await expect(battle.getByLabel('試行履歴')).toContainText('completed');
  await page.reload();
  await battle.getByText('保存した対戦を開く', { exact: true }).click();
  await battle.getByRole('button', { name: id!, exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(battle.getByLabel('対戦ID', { exact: true })).toHaveText(id!);
  await expect(battle.getByRole('status', { name: '対戦の状態' })).toHaveText('完了');
  await battle.getByRole('button', { name: '結果のリプレイを見る' }).click();
  await expect(page.getByRole('table', { name: '記録された状態' }).getByRole('row')).toHaveCount(3);
  const last = (await page
    .getByRole('slider', { name: '表示step', exact: true })
    .getAttribute('max'))!;
  await page.getByLabel('表示stepを入力').fill(last);
  await expect(page.getByLabel('現在のstep')).toHaveText(last);
  await expect(page.getByRole('button', { name: '1step進む' })).toBeDisabled();
  await page.route('**/api/battle-jobs/*', async (route) => {
    const response = await route.fetch();
    const saved = await response.json();
    Object.assign(saved.job, {
      state: 'failed',
      attempts: 1,
      maxAttempts: 3,
      resultId: null,
      allowedOperations: { cancel: false, retry: false },
    });
    await route.fulfill({ json: saved });
  });
  await battle.getByRole('button', { name: '状態を再取得' }).click();
  await expect(battle.getByRole('status', { name: '対戦の状態' })).toHaveText('失敗');
  await expect(battle.getByRole('button', { name: '対戦を再試行', exact: true })).toBeDisabled();
});

test('battle-truncated-result', async ({ page }, info) => {
  await page.goto('/');
  const battle = page.getByRole('region', { name: '非同期対戦' });
  await battle.getByLabel('参加者A').selectOption('swordsman');
  await battle.getByLabel('参加者B').selectOption('sky-mage');
  await battle.getByLabel('乱数seed').fill(String(7092 + info.retry));
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
