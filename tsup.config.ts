import { defineConfig } from 'tsup';

/**
 * Build configuration for ParamGuard.
 *
 * Produces an ESM bundle with type declarations. The shebang on `src/index.ts`
 * is preserved by tsup so the emitted `dist/index.js` is directly executable as
 * the `paramguard` bin. Playwright is kept external — it ships its own binaries
 * and must not be bundled.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2022',
  platform: 'node',
  outDir: 'dist',
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  minify: false,
  shims: false,
  external: ['playwright'],
});
