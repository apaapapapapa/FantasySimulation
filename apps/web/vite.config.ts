import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite-plus';
import { publicBuild } from './public-build.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, '');
  const publicMode = mode === 'public';
  const publication = publicMode
    ? publicBuild(
        env.VITE_PUBLICATION_ROOT || '',
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        env.VITE_PUBLIC_BASE || '/FantasySimulation/',
      )
    : null;
  return {
    base: publication?.base ?? '/',
    define: {
      'import.meta.env.VITE_APP_MODE': JSON.stringify(publicMode ? 'public' : 'local'),
      'import.meta.env.VITE_PUBLICATION_ROOT': JSON.stringify(
        publicMode ? env.VITE_PUBLICATION_ROOT : '',
      ),
    },
    plugins: [react(), ...(publication ? [publication.plugin] : [])],
    envDir: root,
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: publicMode ? {} : { '/api': `http://127.0.0.1:${env.API_PORT || '3001'}` },
    },
    preview: {
      host: '127.0.0.1',
      port: 4173,
      strictPort: true,
      proxy: publicMode ? {} : { '/api': `http://127.0.0.1:${env.API_PORT || '3001'}` },
    },
  };
});
