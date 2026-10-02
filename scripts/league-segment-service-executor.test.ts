import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { expect, it } from 'vite-plus/test';
import {
  segmentServiceReceiptSchema,
  superviseSegmentServiceChild,
} from './league-segment-service-executor.ts';
import type { SealedSegmentReceipt } from './league-sealed-zip-diagnostic.ts';

function receipt(): SealedSegmentReceipt {
  return {
    name: 'league-123-1-segment-0-0-upload-0.zip',
    bytes: 4096,
    digest: 'sha256:' + 'c'.repeat(64),
    sourceSha: 'a'.repeat(40),
    runtimeHash: 'sha256:' + 'd'.repeat(64),
    allocationAttempt: 0,
  };
}
function fake(body: string) {
  // Fake child has no Actions tokens, networking imports, or public SDK authority.
  return spawn(process.execPath, ['-e', body], {
    env: {},
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
}
function reply(expected = receipt()) {
  return JSON.stringify({
    artifact: { id: 456, name: expected.name, bytes: expected.bytes, digest: expected.digest },
    childMaxRssKiB: 50000,
    physicalHttpRequests: 4,
    physicalHttpRequestLimit: expected.name.endsWith('-service-metrics.zip') ? 18 : 26,
  });
}
it('accepts a bounded exact fake receipt only after child close', async () => {
  const child = fake(`require('node:fs').writeSync(3, ${JSON.stringify(reply())});`);
  let closed = false;
  child.once('close', () => {
    closed = true;
  });
  const result = await superviseSegmentServiceChild(child, receipt());
  expect(closed).toBe(true);
  expect(result.terminated).toBe(true);
  expect(result.artifact.id).toBe(456);
  expect(result.sampledCombinedRssBytes).toBeGreaterThan(0);
});
it('samples a valid child alive beyond 300ms despite procfs stat.size zero', async () => {
  const child = fake(
    `require('node:fs').writeSync(3, ${JSON.stringify(reply())});setTimeout(()=>{},450);`,
  );
  const result = await superviseSegmentServiceChild(child, receipt());
  expect(result.terminated).toBe(true);
  expect(result.sampledCombinedRssBytes).toBeGreaterThan(0);
  expect(child.exitCode).toBe(0);
});
it('rejects a failed spawn after close without waiting for the production deadline', async () => {
  const child = spawn('/nonexistent-fantasy-service-child', [], {
    env: {},
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    shell: false,
  });
  let closed = false;
  child.once('close', () => {
    closed = true;
  });
  await expect(
    superviseSegmentServiceChild(child, receipt(), { deadlineMs: 1000, graceMs: 30 }),
  ).rejects.toThrow('spawn-error');
  expect(closed).toBe(true);
  expect(child.pid).toBeUndefined();
});
it.each(['hang', 'resistant'])('terminates a %s child before rejecting', async (kind) => {
  const child = fake(
    `${kind === 'resistant' ? "process.on('SIGTERM',()=>{});" : ''}setInterval(()=>{},1000);`,
  );
  await expect(
    superviseSegmentServiceChild(child, receipt(), { deadlineMs: 1000, graceMs: 30 }),
  ).rejects.toThrow('allocation outcome unknown');
  expect(child.signalCode).toBe(kind === 'resistant' ? 'SIGKILL' : 'SIGTERM');
});
it('aborts and confirms close without leaving the fake child running', async () => {
  const controller = new AbortController();
  const child = fake('setInterval(()=>{},1000);');
  const pending = superviseSegmentServiceChild(child, receipt(), {
    signal: controller.signal,
    graceMs: 30,
  });
  controller.abort();
  await expect(pending).rejects.toThrow('aborted');
  expect(child.signalCode).not.toBeNull();
});
it.each(['stdout', 'stderr', 'receipt'])(
  'bounds %s without returning raw output',
  async (channel) => {
    const fd = channel === 'stdout' ? 1 : channel === 'stderr' ? 2 : 3;
    const child = fake(
      `require('node:fs').createWriteStream('/unused',{fd:${fd},autoClose:false}).write(Buffer.alloc(70000,83));setInterval(()=>{},1000);`,
    );
    const result = superviseSegmentServiceChild(child, receipt(), { graceMs: 30 });
    await expect(result).rejects.toThrow(channel === 'receipt' ? 'receipt-bound' : 'output-bound');
    expect(child.signalCode).not.toBeNull();
  },
);
it.each(['bad-json', 'foreign', 'exit', 'rss'])(
  'rejects %s with generic secret-free errors',
  async (fault) => {
    const foreign = { ...receipt(), name: 'league-999-1-segment-0-0-upload-0.zip' };
    const value =
      fault === 'bad-json'
        ? 'not JSON SECRET_TOKEN'
        : reply(fault === 'foreign' ? foreign : receipt());
    const child = fake(
      `require('node:fs').writeSync(3,${JSON.stringify(value)});${fault === 'exit' ? 'process.exitCode=1;' : ''}`,
    );
    const pending = superviseSegmentServiceChild(
      child,
      receipt(),
      fault === 'rss' ? { rssLimitBytes: 1 } : {},
    );
    await expect(pending).rejects.toThrow('allocation outcome unknown');
  },
);
it('allows only the two fixed pilot names and the smaller metrics byte ceiling', () => {
  expect(segmentServiceReceiptSchema.parse(receipt())).toEqual(receipt());
  expect(
    segmentServiceReceiptSchema.parse({
      ...receipt(),
      name: 'league-123-1-service-metrics.zip',
      bytes: 524288,
    }).bytes,
  ).toBe(524288);
  for (const update of [
    { name: 'league-123-2-service-metrics.zip' },
    { name: 'league-123-1-segment-1-0-upload-0.zip' },
    { allocationAttempt: 1 },
    { name: 'league-123-1-service-metrics.zip', bytes: 524289 },
  ])
    expect(() => segmentServiceReceiptSchema.parse({ ...receipt(), ...update })).toThrow();
});
async function loopback(body: string, metrics = false) {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    response.writeHead(307, { location: `http://${request.headers.host}/again` });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing local fixture address');
    const script = new URL('./league-segment-service-upload.ts', import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      const {installSegmentPhysicalHttpGuard}=await import(${JSON.stringify(script)});
      const guard=installSegmentPhysicalHttpGuard(${JSON.stringify(metrics ? 'metrics' : 'data')});
      const {createRequire}=await import('node:module');
      const {pathToFileURL}=await import('node:url');
      const require=createRequire(import.meta.resolve('@actions/artifact'));
      const url='http://127.0.0.1:${address.port}/again';
      ${body}
    `,
      ],
      { env: {}, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], shell: false },
    );
    const expected = {
      ...receipt(),
      ...(metrics ? { name: 'league-123-1-service-metrics.zip' } : {}),
    };
    await expect(superviseSegmentServiceChild(child, expected)).rejects.toThrow(
      'allocation outcome unknown',
    );
    expect(child.signalCode === 'SIGTERM' || child.exitCode === 1).toBe(true);
    expect(requests).toBe(metrics ? 18 : 26);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
it('caps the pinned Twirp HTTP client redirects before request 27 is created', async () => {
  await loopback(`
    const {HttpClient}=await import(new URL('../../http-client/lib/index.js',import.meta.resolve('@actions/artifact')).href);
    await new HttpClient('local-only-fixture').get(url);
  `);
});
it('caps the pinned Azure REST redirect transport before request 19 is created', async () => {
  await loopback(
    `
    const storageRequire=createRequire(require.resolve('@azure/storage-blob'));
    const core=await import(pathToFileURL(storageRequire.resolve('@azure/core-rest-pipeline')).href);
    const pipeline=core.createPipelineFromOptions({retryOptions:{maxRetries:0}});
    await pipeline.sendRequest(core.createDefaultHttpClient(),core.createPipelineRequest({url,allowInsecureConnection:true}));
  `,
    true,
  );
});
it('updates named builtin exports before CJS snapshots and counts each get/request route once', async () => {
  const script = new URL('./league-segment-service-upload.ts', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    const {createRequire}=await import('node:module');
    const require=createRequire(import.meta.url);
    const named=await import('node:http');
    const before=require('http').request;
    const {installSegmentPhysicalHttpGuard}=await import(${JSON.stringify(script)});
    const guard=installSegmentPhysicalHttpGuard('data');
    const after=require('http').request;
    if(before===after||named.request!==after)process.exit(1);
    for(const [transport,url] of [[require('http'),'https://invalid.local/'],[require('https'),'http://invalid.local/']]) {
      for(const method of ['get','request']) {try{transport[method](url);}catch{}}
    }
    require('fs').writeSync(3,JSON.stringify({...${reply()},...guard.snapshot(),childMaxRssKiB:process.resourceUsage().maxRSS}));
  `,
    ],
    { env: {}, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], shell: false },
  );
  const result = await superviseSegmentServiceChild(child, receipt());
  expect(result.physicalHttpRequests).toBe(4);
  expect(result.physicalHttpRequestLimit).toBe(26);
});
it('fails closed for global fetch without creating a new HTTP request', async () => {
  const script = new URL('./league-segment-service-upload.ts', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    const {installSegmentPhysicalHttpGuard}=await import(${JSON.stringify(script)});
    installSegmentPhysicalHttpGuard('data');
    await fetch('http://127.0.0.1:1/');
  `,
    ],
    { env: {}, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], shell: false },
  );
  await expect(superviseSegmentServiceChild(child, receipt())).rejects.toThrow(
    'allocation outcome unknown',
  );
  expect(child.signalCode === 'SIGTERM' || child.exitCode === 1).toBe(true);
});
it('rejects proxy environment before loading a service dependency or touching a file', async () => {
  const script = new URL('./league-segment-service-upload.ts', import.meta.url);
  const { fileURLToPath } = await import('node:url');
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(script),
      '/nonexistent-sealed-fixture.zip',
      JSON.stringify(receipt()),
    ],
    {
      env: { ACTIONS_ARTIFACT_UPLOAD_CONCURRENCY: '1', HTTP_PROXY: 'http://fake-secret.invalid/' },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      shell: false,
    },
  );
  let emitted = 0;
  child.stdout?.on('data', (chunk: Buffer) => {
    emitted += chunk.length;
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    emitted += chunk.length;
  });
  await expect(superviseSegmentServiceChild(child, receipt())).rejects.toThrow(
    'allocation outcome unknown',
  );
  expect(emitted).toBe(0);
});
it('counts the pinned Azure REST retries on a loopback fixture without an SDK service', async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(requests < 3 ? 500 : 200);
    response.end('local fixture');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing local address');
    const script = new URL('./league-segment-service-upload.ts', import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      const {installSegmentPhysicalHttpGuard}=await import(${JSON.stringify(script)});
      const guard=installSegmentPhysicalHttpGuard('data');
      const {createRequire}=await import('node:module');
      const {pathToFileURL}=await import('node:url');
      const require=createRequire(import.meta.resolve('@actions/artifact'));
      const storageRequire=createRequire(require.resolve('@azure/storage-blob'));
      const core=await import(pathToFileURL(storageRequire.resolve('@azure/core-rest-pipeline')).href);
      const pipeline=core.createPipelineFromOptions({retryOptions:{maxRetries:2,retryDelayInMs:1,maxRetryDelayInMs:1}});
      const response=await pipeline.sendRequest(core.createDefaultHttpClient(),core.createPipelineRequest({
        url:'http://127.0.0.1:${address.port}/',allowInsecureConnection:true}));
      if(response.status!==200)process.exit(1);
      require('fs').writeSync(3,JSON.stringify({...${reply()},...guard.snapshot(),childMaxRssKiB:process.resourceUsage().maxRSS}));
    `,
      ],
      { env: {}, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], shell: false },
    );
    const result = await superviseSegmentServiceChild(child, receipt());
    expect(result.physicalHttpRequests).toBe(3);
    expect(requests).toBe(3);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
