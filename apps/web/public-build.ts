import { SUPPORTED_REPLAY_FORMAT, ViewerBuildSchema } from '@fantasy/domain';
import type { Plugin } from 'vite-plus';

export function publicBuild(dataRoot: string, sourceSha: string, base = '/FantasySimulation/') {
  const url = new URL(dataRoot);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) ||
    !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base)
  )
    throw new Error('Invalid public data origin or base path');
  const metadata = ViewerBuildSchema.parse({
    schemaVersion: 1,
    sourceSha,
    publicationSchema: 1,
    replay: SUPPORTED_REPLAY_FORMAT,
  });
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${url.origin}`,
    "worker-src 'self' blob:",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'none'",
  ].join('; ');
  const plugin: Plugin = {
    name: 'public-viewer-metadata',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: csp },
        injectTo: 'head-prepend',
      },
    ],
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'build.json',
        source: JSON.stringify(metadata) + '\n',
      });
    },
  };
  return { base, metadata, csp, plugin };
}
