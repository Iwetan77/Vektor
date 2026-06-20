import { defineConfig } from 'tsup'

/**
 * Pre-bundles the Vercel serverless function into a single self-contained ESM
 * file at api/index.js.
 *
 * Why: Vercel's serverless runtime crashes with ERR_REQUIRE_ESM when a CommonJS
 * dependency internally require()s an ESM-only module (e.g. rpc-websockets -> uuid,
 * or @cetusprotocol -> @mysten/sui). Bundling inlines every dependency, so those
 * require() calls become inlined code and never reach the runtime module loader.
 *
 * routex-sui is left EXTERNAL (and loaded lazily by swap routes only): its
 * transitive deps (@cetusprotocol, @7kprotocol) ship broken ESM builds esbuild
 * can't resolve. The negative-lookahead noExternal bundles everything else.
 */
export default defineConfig({
  entry: { index: 'vercel-entry.ts' },
  outDir: 'api',
  format: ['esm'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  sourcemap: false,
  dts: false,
  clean: false,
  splitting: false,
  noExternal: [/^(?!routex-sui|@mysten\/walrus).+/],
  external: ['routex-sui', '@mysten/walrus', '@mysten/walrus-wasm'],
  // Recreate require/__dirname/__filename in the ESM output so bundled CommonJS
  // deps that call require('fs') etc. resolve Node builtins at runtime.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'module';",
      "import { fileURLToPath as __fileURLToPath } from 'url';",
      "import { dirname as __pathDirname } from 'path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __pathDirname(__filename);',
    ].join('\n'),
  },
})
