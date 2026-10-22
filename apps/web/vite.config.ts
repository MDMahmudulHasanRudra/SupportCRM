import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The operator console.
 *
 * Port 3000 is not arbitrary: it is the origin the API already allows in `CORS_ORIGINS`, and
 * `localhost:3000` and `localhost:4000` are the same *site*, so the API's `SameSite=lax` session
 * cookie is sent on these requests without weakening it to `SameSite=none`.
 *
 * There is no proxy to the WhatsApp gateway here, and there never should be — the browser talks
 * only to the Support CRM API (`docs/WHATSAPP_UX_ARCHITECTURE.md` §2).
 */
export default defineConfig({
  plugins: [react()],
  server: { port: 3000, strictPort: true },
  preview: {
    port: 3000, strictPort: true,
    proxy: { '/api': 'http://localhost:4000', '/socket.io': { target: 'http://localhost:4000', ws: true } },
  },
  build: { outDir: 'dist', sourcemap: true },
});
