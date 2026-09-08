import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  // Resolve Svelte's browser (client) build so component mount() works under
  // happy-dom; without this Svelte 5 resolves its server build and throws
  // "mount(...) is not available on the server".
  resolve: {
    conditions: ['browser'],
    // Mirror astro.config.mjs so tests resolve the shared reader core the same
    // way the site build does (e.g. app/src/lib/html re-exports @shared/lib/html).
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  // The @shared alias above points outside this package, and shared/lib/data.ts
  // reaches further still — through glossary.ts to `../glossary/EN.md?raw`.
  // Vite's default fs root is app/, so that asset was denied and any test
  // importing shared/lib/data failed to collect at all ("Denied ID …EN.md?raw")
  // rather than failing a assertion. Allow the repo root the alias already uses.
  server: {
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.{test,spec}.ts'],
    restoreMocks: true,
  },
});
