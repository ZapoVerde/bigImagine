import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev-only convenience: `npm run dev` here talks to a real deployed (or locally running)
// orchestrator instead of needing a full Docker rebuild per change. Production doesn't use this
// at all — the built dist/ is served directly by the orchestrator itself (httpServer.ts).
const proxyTarget = process.env.BB_DEV_PROXY_TARGET ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/v1': proxyTarget,
      '/healthz': proxyTarget,
    },
  },
});
