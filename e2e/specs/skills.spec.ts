import { test, expect } from '../fixtures.ts';
import { gunzipSync } from 'node:zlib';

type DependentReplayEvidence = {
  step?: number;
  events?: { kind: string; entityId?: string | null }[];
  dependents?: {
    update?: { id: string }[];
    remove?: { id: string; reason: string }[];
  };
};

async function readyWorkbench(page: import('@playwright/test').Page) {
  await page.goto('/');
  const workbench = page.locator('.skill-workbench');
  await expect(workbench.locator('fieldset').first()).toBeEnabled();
  await expect(workbench.locator('.skill-matrix tbody tr')).toHaveCount(6);
  await expect(workbench.locator('.skill-matrix tbody td')).toHaveCount(72);
  await expect(workbench.locator('.skill-matrix tbody td > button')).toHaveCount(72);
  return workbench;
}

async function saveSelectedSkill(
  page: import('@playwright/test').Page,
  workbench: import('@playwright/test').Locator,
) {
  const nodeAction = workbench.locator('.skill-node-action');
  await nodeAction.click();
  await nodeAction.click();
  await workbench.locator('.actions .primary').click();
  await expect(workbench.locator('.message[role="status"]')).toContainText(/revision \d+/);
  const battle = page.locator('.arena');
  await expect(battle.locator(':scope > p[role="status"]').first()).toContainText(/revision \d+/);
  return battle;
}

async function submitBattleAndOpenReplay(
  page: import('@playwright/test').Page,
  battle: import('@playwright/test').Locator,
  latest: unknown,
) {
  await battle.locator('select').nth(3).selectOption('standard-p6-group2-v1');
  await expect(battle.locator('select').nth(3)).toHaveValue('standard-p6-group2-v1');
  const battleRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/api/skill-battle-jobs'),
  );
  await battle.locator(':scope > fieldset > button.primary').click();
  const submitted = (await battleRequest).postDataJSON();
  expect(submitted.spec.ruleset).toEqual({
    id: 'standard-p6-group2-v1',
    revision: 1,
    contentHash: 'sha256:7a29dffc918f926dfe030ea3ae9bf488d582abae743179cb60617cbd1c7016d3',
  });
  expect(submitted.loadouts).toEqual([{ actorId: 'left', loadout: latest }]);
  await expect(battle.locator('.result')).toBeVisible({ timeout: 15_000 });
  const replayResponse = page.waitForResponse((response) =>
    /\/api\/replays\/[^/]+$/.test(response.url()),
  );
  await battle.locator('.result button').click();
  return { submitted, response: await replayResponse };
}

test('skill-workbench-desktop', async ({ page }) => {
  const workbench = await readyWorkbench(page);

  await expect(workbench.locator('.local-note')).toContainText('ローカル専用');
  await expect(workbench.locator('.local-note')).toContainText('公開Pages');
  await expect(workbench).toContainText('条件を解除すると再び選べます');
  await expect(workbench.locator('.skill-paths > button')).toHaveCount(16);

  const firstNode = workbench.locator('.skill-matrix tbody td > button').first();
  const nodeName = (await firstNode.locator('strong').textContent())!.trim();
  const search = workbench.locator('input[type="search"]');
  await search.fill(nodeName);
  await expect(workbench.locator('.skill-matrix tbody td')).toHaveCount(72);
  await expect(workbench.locator('.skill-matrix tbody td[data-match="true"]')).not.toHaveCount(0);
  await expect(workbench.locator('.skill-matrix tbody td[data-match="false"]')).not.toHaveCount(0);
  await expect(
    workbench.locator('.skill-matrix tbody td[data-match="false"] > button').first(),
  ).toBeDisabled();
  await expect(
    workbench.locator('.skill-matrix tbody td[data-match="false"] > button').first(),
  ).toBeHidden();
  await expect(
    workbench.locator('.skill-matrix tbody td[data-match="false"] > button').first(),
  ).toHaveAttribute('aria-hidden', 'true');
  await expect(
    workbench.locator('.skill-matrix tbody td[data-match="false"] > button').first(),
  ).toHaveAttribute('tabindex', '-1');

  await firstNode.click();
  const detail = workbench.locator('.skill-detail');
  await expect(detail).toBeVisible();
  await expect(detail.locator('h3')).toHaveText(nodeName);
  await expect(detail.locator('dl > div')).toHaveCount(7);
  await expect(detail.locator('.skill-node-action')).toBeVisible();

  await search.fill('no-such-workbench-node');
  await expect(workbench.locator('.skill-detail')).toHaveCount(0);
  await expect(workbench.locator('.skill-matrix tbody td > button:enabled')).toHaveCount(0);
  await search.fill('');
  await expect(workbench.locator('.skill-matrix tbody td > button:enabled')).toHaveCount(72);
  await firstNode.click();
  await expect(workbench.locator('.skill-detail')).toBeVisible();

  const foundation = workbench.locator('.skill-matrix tbody td > button').nth(60);
  await foundation.click();
  const battle = await saveSelectedSkill(page, workbench);
  await battle.locator(':scope > fieldset > button.primary').click();
  await expect(battle.locator('.result')).toBeVisible({ timeout: 15_000 });
  await battle.locator('.result button').click();
  await expect(page.locator('input[type="range"]')).toBeVisible();
});

test('skill-workbench-mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const workbench = await readyWorkbench(page);
  const paths = workbench.locator('.skill-paths');
  const matrix = workbench.locator('.skill-matrix-scroll');

  expect(
    await paths.evaluate((element) => element.scrollWidth > element.clientWidth),
    'path selector should scroll horizontally on mobile',
  ).toBe(true);
  expect(
    await matrix.evaluate((element) => element.scrollWidth > element.clientWidth),
    '72-cell matrix should scroll horizontally on mobile',
  ).toBe(true);

  await matrix.focus();
  await expect(matrix).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => matrix.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);

  const node = workbench.locator('.skill-matrix tbody td > button').nth(12);
  await node.click();
  await expect(workbench.locator('.skill-detail')).toBeVisible();
  await expect(workbench.locator('.skill-node-action')).toHaveCSS('min-height', '44px');
  expect(
    await workbench
      .locator('.skill-loadout-controls')
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length),
  ).toBe(1);
});

test('magic tiger prerequisite loadout reloads into an exact battle and replay', async ({
  page,
}) => {
  const workbench = await readyWorkbench(page);
  await workbench
    .locator('.skill-paths > button')
    .filter({ hasText: 'elements, affinity and formations' })
    .click();

  const condition = workbench.getByRole('button', { name: /Flame Pressure: Condition/ });
  await condition.click();
  await expect(workbench.locator('.skill-state')).toHaveText('未解放');
  await expect(workbench.locator('.skill-blockers')).toContainText('Flame Pressure: Foundation');
  await expect(workbench.locator('.skill-node-action')).toBeDisabled();

  await workbench.getByRole('button', { name: /Flame Pressure: Foundation/ }).click();
  await workbench.locator('.skill-node-action').click();
  await expect(workbench.locator('.skill-state')).toHaveText('習得済み');

  await condition.click();
  await expect(workbench.locator('.skill-state')).toHaveText('習得可能');
  await workbench.locator('.skill-node-action').click();
  await workbench.locator('.skill-node-action').click();
  await expect(workbench.locator('.skill-state')).toHaveText('編成中');

  const savedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().endsWith('/api/skill-loadouts'),
  );
  await workbench.locator('.actions .primary').click();
  const saved = await (await savedResponse).json();
  expect(saved.snapshot.configuration).toMatchObject({
    learnedNodeIds: ['skill.magic.tiger.1', 'skill.magic.tiger.2'],
    enabledNodeIds: ['skill.magic.tiger.2'],
  });
  expect(saved.snapshot.resolved).toMatchObject({
    catalog: { id: 'skill-catalog-v1', revision: 10 },
    resolvedNodeIds: ['skill.magic.tiger.1', 'skill.magic.tiger.2'],
  });

  await page.reload();
  const reloaded = page.locator('.skill-workbench');
  await expect(reloaded.locator('fieldset').first()).toBeEnabled();
  await reloaded.getByLabel('保存済み構成').selectOption(`${saved.id}:${saved.latest.revision}`);
  await expect(reloaded.locator('.message[role="status"]')).toContainText(
    `revision ${saved.latest.revision}`,
  );
  await reloaded
    .locator('.skill-paths > button')
    .filter({ hasText: 'elements, affinity and formations' })
    .click();
  await reloaded.getByRole('button', { name: /Flame Pressure: Foundation/ }).click();
  await expect(reloaded.locator('.skill-state')).toHaveText('習得済み');
  await reloaded.getByRole('button', { name: /Flame Pressure: Condition/ }).click();
  await expect(reloaded.locator('.skill-state')).toHaveText('編成中');

  const battle = page.locator('.arena');
  await expect(battle.locator(':scope > p[role="status"]').first()).toContainText(
    `${saved.id}・revision ${saved.latest.revision}`,
  );
  const { response } = await submitBattleAndOpenReplay(page, battle, saved.latest),
    replayManifest = await response.json();
  expect(replayManifest.input.participants[0].skillLoadout).toMatchObject({
    loadout: saved.latest,
    catalog: saved.snapshot.resolved.catalog,
    resolvedNodeIds: ['skill.magic.tiger.1', 'skill.magic.tiger.2'],
    nodeResolutions: saved.snapshot.resolved.nodeResolutions,
    resolutionDigest: saved.snapshot.resolved.resolutionDigest,
  });
  await expect(page.locator('input[type="range"]')).toBeVisible();
});

test('rabbit hologram saves, battles and replays through both viewers', async ({ page }) => {
  const workbench = await readyWorkbench(page);
  await workbench
    .locator('.skill-paths > button')
    .filter({ hasText: 'debuff, mind and perception' })
    .click();
  const rabbitFoundation = workbench.getByRole('button', { name: /Side-Step Image/ });
  await rabbitFoundation.click();
  await expect(workbench.locator('.skill-detail h3')).toHaveText('Side-Step Image');
  const savedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().endsWith('/api/skill-loadouts'),
  );
  const battle = await saveSelectedSkill(page, workbench);
  const saved = await (await savedResponse).json();
  expect(saved.snapshot.resolved).toMatchObject({
    resolvedNodeIds: ['skill.illusion-curse.rabbit.1'],
    nodeResolutions: [
      {
        nodeId: 'skill.illusion-curse.rabbit.1',
        resolution: [
          {
            kind: 'active-ability',
            ability: {
              id: 'side-step-image-v1',
              revision: 1,
              contentHash:
                'sha256:96e42f32200a1d27beffa1a185a79206b847ce2a1ff162b680150bab6a0aa1fa',
            },
          },
        ],
      },
    ],
  });
  const { submitted, response } = await submitBattleAndOpenReplay(page, battle, saved.latest),
    replayManifest = await response.json();
  expect(replayManifest.input.ruleset).toEqual(submitted.spec.ruleset);
  expect(replayManifest.input.participants[0].skillLoadout).toMatchObject({
    loadout: saved.latest,
    catalog: saved.snapshot.resolved.catalog,
    resolvedNodeIds: saved.snapshot.resolved.resolvedNodeIds,
    nodeResolutions: saved.snapshot.resolved.nodeResolutions,
    resolutionDigest: saved.snapshot.resolved.resolutionDigest,
  });

  const replay = page.locator('section').filter({ has: page.locator('input[type="range"]') });
  await expect(replay.locator('canvas')).toBeVisible();
  const view = replay
    .locator('.actions select')
    .filter({ has: page.locator('option[value="2d"]') });
  await view.selectOption('2d');
  const slider = replay.locator('input[type="range"]');
  await expect(slider).toBeVisible();
  await slider.fill((await slider.getAttribute('max'))!);
  const projections = replay.locator('[data-environmental-hologram]');
  await expect(projections.first()).toBeVisible();
  const id = await projections.first().getAttribute('data-environmental-hologram');
  expect(id).toBeTruthy();
});

test('scout rat saves, battles and replays one dependent through both viewers', async ({
  page,
}) => {
  const catalogResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      response.url().endsWith('/api/skill-catalogs/skill-catalog-v1/10'),
  );
  const workbench = await readyWorkbench(page);
  const fetchedCatalog = await (await catalogResponse).json();
  expect(fetchedCatalog.catalog).toMatchObject({ id: 'skill-catalog-v1', revision: 10 });
  await workbench.getByRole('button', { name: /summon, command and possession/ }).click();
  const ratFoundation = workbench.getByRole('button', { name: /Scout Rat/ });
  await ratFoundation.click();
  await expect(workbench.locator('.skill-detail h3')).toHaveText('Scout Rat');
  const savedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().endsWith('/api/skill-loadouts'),
  );
  const battle = await saveSelectedSkill(page, workbench);
  const saved = await (await savedResponse).json();
  expect(saved.snapshot.resolved).toMatchObject({
    catalog: { id: 'skill-catalog-v1', revision: 10 },
    resolvedNodeIds: ['skill.summoning.rat.1'],
    nodeResolutions: [
      {
        nodeId: 'skill.summoning.rat.1',
        resolution: [
          {
            kind: 'active-ability',
            ability: {
              id: 'scout-rat-v1',
              revision: 1,
              contentHash:
                'sha256:c137e74851756fbdd5d8aefcdaecd325347758ad1627c1bc7f7a21b673687927',
            },
          },
        ],
      },
    ],
  });
  const { response: replayHttpResponse } = await submitBattleAndOpenReplay(
    page,
    battle,
    saved.latest,
  );
  const replayManifest = await replayHttpResponse.json();
  expect(replayManifest.input.schemaVersion).toBe(9);
  expect(replayManifest.input.participants[0].skillLoadout).toMatchObject({
    loadout: saved.latest,
    resolvedNodeIds: ['skill.summoning.rat.1'],
  });

  const chunks = replayManifest.chunks as { file: string }[],
    records = (
      await Promise.all(
        chunks.map(async ({ file }) => {
          const response = await page.request.get(`${replayHttpResponse.url()}/files/${file}`);
          expect(response.ok()).toBe(true);
          return gunzipSync(await response.body())
            .toString('utf8')
            .trimEnd()
            .split('\n')
            .map((line) => JSON.parse(line) as DependentReplayEvidence);
        }),
      )
    ).flat(),
    create = records
      .flatMap(({ events = [] }) => events)
      .find(({ kind }) => kind === 'dependent-create'),
    dependentId = create?.entityId,
    activeStep = records.find(
      (record) =>
        record.step !== undefined &&
        record.dependents?.update?.some(({ id }) => id === dependentId),
    )?.step,
    expiryStep = records.find(
      (record) =>
        record.step !== undefined &&
        record.dependents?.remove?.some(
          ({ id, reason }) => id === dependentId && reason === 'expired',
        ),
    )?.step;
  expect(dependentId).toBe('dependent.a.0.scout-rat');
  expect(activeStep).toBeGreaterThan(0);
  expect(expiryStep).toBeGreaterThan(activeStep!);

  const replay = page.locator('section').filter({ has: page.locator('input[type="range"]') }),
    slider = replay.locator('input[type="range"]'),
    view = replay.locator('.actions select').filter({ has: page.locator('option[value="2d"]') });
  await expect(slider).toBeVisible();
  await slider.fill(String(activeStep));
  await expect(replay.locator('canvas')).toHaveAttribute('data-rendered', 'true');
  const dependent = replay.locator(`[data-dependent="${dependentId}"]`);
  await view.selectOption('2d');
  await expect(dependent).toBeVisible();
  await slider.fill(String(expiryStep));
  await expect(replay.locator('[data-dependent]')).toHaveCount(0);
  await slider.fill((await slider.getAttribute('max'))!);
  await expect(replay.locator('[data-dependent]')).toHaveCount(0);
});
