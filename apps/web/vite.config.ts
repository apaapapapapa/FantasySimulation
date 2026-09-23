import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite-plus';

const root = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, '');
  const publicMode = mode === 'public';
  if (publicMode) {
    const data = new URL(env.VITE_PUBLICATION_ROOT || '');
    if (
      !['http:', 'https:'].includes(data.protocol) ||
      data.username ||
      data.password ||
      data.search ||
      data.hash
    )
      throw new Error('VITE_PUBLICATION_ROOT must be an HTTP(S) directory URL');
  }
  return {
    base: publicMode ? '/FantasySimulation/' : '/',
    define: {
      'import.meta.env.VITE_APP_MODE': JSON.stringify(publicMode ? 'public' : 'local'),
      'import.meta.env.VITE_PUBLICATION_ROOT': JSON.stringify(
        publicMode ? env.VITE_PUBLICATION_ROOT : '',
      ),
    },
    plugins: [react()],
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
