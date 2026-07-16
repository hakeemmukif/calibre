/** @type {import('next').NextConfig} */
// The Docker image runs `next start` (Dockerfile CMD), so `output` is left at the
// default. `output: "standalone"` conflicts with `next start` (Next 15.5 warns it
// "does not work") and the runtime image keeps full node_modules regardless, for
// the tsx/drizzle-kit one-offs (db:migrate, db:seed, migrate-uploads). Résumé
// uploads still root from CALIBER_UPLOADS_DIR, never process.cwd() (Step 5).
// `@napi-rs/canvas` (native .node binding, used by src/lib/rasterize.ts for the
// vision résumé path) must be require()'d at runtime, not webpacked — bundling
// its skia.*.node binary fails the build. serverExternalPackages externalizes it
// for the server bundle.
export default {
  reactStrictMode: true,
  serverExternalPackages: ["@napi-rs/canvas"],
};
