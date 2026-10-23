import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vitest/config';

/** Serve and emit the repo's THIRD_PARTY_LICENSES so the footer link works in dev and prod. */
function thirdPartyLicenses(): Plugin {
  const name = 'THIRD_PARTY_LICENSES.txt';
  const read = () => readFileSync(new URL('./THIRD_PARTY_LICENSES', import.meta.url), 'utf8');
  return {
    name: 'third-party-licenses',
    configureServer(server) {
      server.middlewares.use(`/${name}`, (_req, res) => {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(read());
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: name, source: read() });
    },
  };
}

// Relative base so the build works at any GitHub Pages path (/stemlight/).
export default defineConfig({
  base: process.env.STEMLIGHT_BASE ?? './',
  plugins: [thirdPartyLicenses()],
  worker: { format: 'es' },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 120_000 },
});
