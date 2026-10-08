import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Page } from '@playwright/test';
import { HashSchema, IdSchema, PublicCatalogCurrentSchema } from '@fantasy/domain/spatial';
import { leagueLink } from '../apps/web/src/publication/league-route.ts';
import { CHROMIUM_ARGS } from '../e2e/contract.ts';
import { readBoundedJson } from './harness/files.ts';
import { record } from './harness/report.ts';

export interface PagesExpectation {
  viewerUrl: string;
  catalogHash: string;
  league: { id: string; snapshot: string };
}
/** One fresh browser context: no HTTP cache, storage or service worker from an earlier visit. */
export interface PagesVisit {
  page: Page;
  close(): Promise<void>;
}
export interface PagesTiming {
  deadlineMs: number;
  intervalMs: number;
  stepTimeoutMs?: number;
  maxAttempts?: number;
}
export const PAGES_ACCEPTANCE_FILE = 'pages-acceptance.json';

/** The viewer URL a person opens: no query or fragment that could bypass a cache. */
export function normalViewerUrl(value: string) {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    !url.pathname.endsWith('/')
  )
    throw new Error('Pages acceptance requires the normal viewer URL');
  return url.href;
}
/** The committed pipeline result the fresh browser must observe. */
export function pagesExpectation(viewerUrl: string, completion: unknown): PagesExpectation {
  const value = record(completion),
    league = record(value.league);
  const catalogHash = HashSchema.safeParse(value.catalogHash),
    id = IdSchema.safeParse(league.id),
    snapshot = HashSchema.safeParse(league.snapshot);
  if (
    record(value.outcome).status !== 'verified' ||
    value.recover !== false ||
    !catalogHash.success ||
    !id.success ||
    !snapshot.success
  )
    throw new Error('Pages acceptance requires a verified new publication');
  return {
    viewerUrl: normalViewerUrl(viewerUrl),
    catalogHash: catalogHash.data,
    league: { id: id.data, snapshot: snapshot.data },
  };
}

/** Response bodies per origin until acceptance: viewer assets and publication reads separately. */
function observeTraffic(page: Page) {
  const traffic = new Map<string, { requests: number; bytes: number; unsized: number }>(),
    pending: Promise<void>[] = [];
  page.on('requestfinished', (request) => {
    const origin = new URL(request.url()).origin,
      entry = traffic.get(origin) ?? { requests: 0, bytes: 0, unsized: 0 };
    traffic.set(origin, entry);
    entry.requests++;
    // A browser without body sizes leaves the request counted and its bytes explicitly unknown.
    const unsized = () => void entry.unsized++;
    if (pending.length >= 10000) return unsized();
    pending.push(
      request.sizes().then(({ responseBodySize }) => {
        if (responseBodySize >= 0) entry.bytes += responseBodySize;
        else unsized();
      }, unsized),
    );
  });
  return async () => {
    await Promise.all(pending);
    return [...traffic].map(([origin, value]) => ({ origin, ...value }));
  };
}

async function visit({ page }: PagesVisit, expected: PagesExpectation, timeout: number) {
  const started = performance.now(),
    elapsed = () => Math.round(performance.now() - started),
    traffic = observeTraffic(page);
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) => new URL(candidate.url()).pathname.endsWith('/catalog/current.json'),
      { timeout },
    ),
    page.goto(expected.viewerUrl, { waitUntil: 'domcontentloaded', timeout }),
  ]);
  if (!response.ok()) throw new Error(`Catalog pointer HTTP ${response.status()}`);
  const current = PublicCatalogCurrentSchema.parse(await response.json());
  if (current.catalogHash !== expected.catalogHash)
    throw new Error(`Stale catalog ${current.catalogHash}`);
  const pointerMs = elapsed();
  // IDs are [a-z0-9._-]; an experimental league carries a visible suffix.
  const name = new RegExp(`^${expected.league.id.replaceAll('.', '\\.')}(?:（実験）)?$`);
  await page
    .getByRole('navigation', { name: '公開データ' })
    .getByRole('link', { name })
    .click({ timeout });
  const route = leagueLink(expected.league.snapshot);
  await page.waitForURL((url) => url.hash === route, { timeout });
  // Read the standings before leaving them for the pair and replay pages.
  const heading = page.getByRole('heading', { name: /^(?:正式|暫定)ランキング$/ });
  const formal = (await heading.textContent({ timeout })) === '正式ランキング';
  const summary = await page.getByRole('region', { name: 'リーグ概要' }).textContent({ timeout });
  const counts = /([\d,]+)\s*\/\s*([\d,]+)枠が確定/.exec(summary ?? '');
  if (!counts) throw new Error('League completion is not visible');
  const leagueMs = elapsed();
  await page.getByRole('button', { name: '相性表', exact: true }).click({ timeout });
  await page
    .getByRole('table', { name: '相性表', exact: true })
    .getByRole('link')
    .first()
    .click({ timeout });
  await page
    .getByRole('table', { name: 'リーグ所属試合', exact: true })
    .getByRole('link')
    .first()
    .click({ timeout });
  const replayId = IdSchema.parse(
    (await page.getByLabel('リプレイID', { exact: true }).textContent({ timeout }))?.trim(),
  );
  await page.getByLabel('現在のstep').filter({ hasText: /^0$/ }).waitFor({ timeout });
  return {
    formal,
    resolved: Number(counts[1]!.replaceAll(',', '')),
    planned: Number(counts[2]!.replaceAll(',', '')),
    replayId,
    timings: { pointerMs, leagueMs, replayMs: elapsed() },
    traffic: await traffic(),
  };
}

/**
 * Retries in brand-new contexts, never with a cache buster, until the committed snapshot and one
 * of its replays play or the deadline passes. The acceptance instant precedes context teardown.
 */
export async function acceptPublishedLeague(
  open: () => Promise<PagesVisit>,
  expected: PagesExpectation,
  { deadlineMs, intervalMs, stepTimeoutMs = 30000, maxAttempts = 100 }: PagesTiming,
) {
  const started = Date.now();
  const attempts: { startedAt: string; error: string | null }[] = [];
  const base = {
    schemaVersion: 1,
    viewerUrl: expected.viewerUrl,
    catalogHash: expected.catalogHash,
    league: expected.league,
    startedAt: new Date(started).toISOString(),
    attempts,
  };
  for (;;) {
    const startedAt = new Date().toISOString(),
      remaining = Math.max(1, started + deadlineMs - Date.now());
    let session: PagesVisit | undefined;
    let watchdog: NodeJS.Timeout | undefined;
    try {
      session = await open();
      const current = session;
      // Closing the context rejects every pending wait, bounding the attempt by the deadline.
      watchdog = setTimeout(() => void current.close().catch(() => {}), remaining);
      const observed = await visit(current, expected, Math.min(stepTimeoutMs, remaining));
      const acceptedAt = new Date().toISOString();
      attempts.push({ startedAt, error: null });
      return { ...base, status: 'accepted' as const, ...observed, acceptedAt };
    } catch (error) {
      attempts.push({ startedAt, error: String((error as Error)?.message ?? error).slice(0, 500) });
    } finally {
      clearTimeout(watchdog);
      await session?.close().catch(() => {});
    }
    if (Date.now() + intervalMs >= started + deadlineMs || attempts.length >= maxAttempts)
      return { ...base, status: 'failed' as const, failedAt: new Date().toISOString() };
    await new Promise((settle) => setTimeout(settle, intervalMs));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.env.FANTASY_MEASUREMENTS_DIR;
  if (!directory) throw new Error('Missing FANTASY_MEASUREMENTS_DIR');
  const expected = pagesExpectation(
    process.env.PUBLICATION_VIEWER_URL ?? '',
    readBoundedJson(resolve('.generated/league-pipeline/completion.json'), 1024 * 1024),
  );
  let result: Record<string, unknown>;
  try {
    const browser = await chromium.launch({ args: CHROMIUM_ARGS });
    try {
      const accepted = await acceptPublishedLeague(
        async () => {
          const context = await browser.newContext({
            locale: 'ja-JP',
            timezoneId: 'Asia/Tokyo',
            serviceWorkers: 'block',
          });
          return { page: await context.newPage(), close: () => context.close() };
        },
        expected,
        { deadlineMs: 120000, intervalMs: 5000 },
      );
      result = { ...accepted, browser: `chromium ${browser.version()}` };
    } finally {
      await browser.close();
    }
  } catch (error) {
    result = { schemaVersion: 1, status: 'failed', reason: String(error).slice(0, 500) };
  }
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, PAGES_ACCEPTANCE_FILE), JSON.stringify(result) + '\n');
  if (result.status !== 'accepted') {
    process.exitCode = 1;
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        'Fresh-browser Pages acceptance failed; the verified publication stays committed.\n',
      );
  }
}
