import { defineConfig } from 'tsup'
import path from 'path'

/**
 * Forces the broken-ESM swap SDKs to resolve to their working CommonJS builds.
 * Both ship an `exports`/`module` ESM entry that statically imports symbols no
 * longer present in @mysten/sui v2 (`Commands`, `fromB64`), which esbuild can't
 * bundle. Their CJS `dist/index.js` builds use runtime property access instead
 * and bundle fine.
 */
const forceCjsSwapSdks = {
  name: 'force-cjs-swap-sdks',
  setup(build: any) {
    const map: Record<string, string> = {
      '@7kprotocol/sdk-ts': 'node_modules/@7kprotocol/sdk-ts/dist/index.js',
      '@cetusprotocol/cetus-sui-clmm-sdk': 'node_modules/@cetusprotocol/cetus-sui-clmm-sdk/dist/index.js',
    }
    const filter = /^(@7kprotocol\/sdk-ts|@cetusprotocol\/cetus-sui-clmm-sdk)$/
    build.onResolve({ filter }, (args: any) => ({
      path: path.resolve(process.cwd(), map[args.path]),
    }))
  },
}

/**
 * Pre-bundles the Vercel serverless function into a single self-contained ESM
 * file at api/index.js.
 *
 * Why: Vercel's serverless runtime crashes with ERR_REQUIRE_ESM / cannot
 * require() an ESM module in a cycle, when CommonJS deps internally require()
 * an ESM-only module (rpc-websockets -> uuid, @cetusprotocol -> @mysten/sui).
 * Bundling inlines every dependency (exactly what tsx does locally), so those
 * require() calls become inlined code and never reach the runtime module loader.
 *
 * mainFields prefers each package's CommonJS "main" over its "module" (ESM)
 * entry. @cetusprotocol / @7kprotocol ship a BROKEN esm build (imports
 * `fromB64` which no longer exists in @mysten/bcs v2) but a working CJS build;
 * forcing CJS lets esbuild bundle them. Packages with an "exports" field
 * (@mysten/sui etc.) ignore mainFields and still resolve correctly.
 *
 * @mysten/walrus is left EXTERNAL: it loads a .wasm asset via readFileSync at a
 * path relative to its own node_modules dir, so it must stay on disk rather than
 * be inlined. It is loaded lazily (Echo / contacts routes only) and shipped via
 * `includeFiles` in vercel.json.
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
  // Keep WASM-loading packages external so they read their .wasm assets from
  // their own node_modules dir at runtime (shipped via includeFiles in vercel.json).
  noExternal: [/^(?!@mysten\/walrus|@mysten\/move-bytecode-template).+/],
  external: ['@mysten/walrus', '@mysten/walrus-wasm', '@mysten/move-bytecode-template'],
  esbuildPlugins: [forceCjsSwapSdks],
  esbuildOptions(options) {
    // Prefer CommonJS entry points for legacy SDKs without an exports field.
    options.mainFields = ['main', 'module']
  },
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
