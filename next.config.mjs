/** @type {import('next').NextConfig} */
// `output: "standalone"` bundles a minimal self-contained server (.next/standalone)
// for the Docker image (system-architecture.md §6 deploy). The runtime cwd becomes
// .next/standalone — exactly why résumé uploads root from CALIBER_UPLOADS_DIR
// (Step 5), never process.cwd().
// `@napi-rs/canvas` (native .node binding, used by src/lib/rasterize.ts for the
// vision résumé path) must be require()'d at runtime, not webpacked — bundling
// its skia.*.node binary fails the build. serverExternalPackages externalizes it
// for the server bundle.
export default {
  reactStrictMode: true,
  output: "standalone",
  serverExternalPackages: ["@napi-rs/canvas"],
};
