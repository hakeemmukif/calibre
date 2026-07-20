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
  // PostHog reverse proxy (spec §3): first-party /ingest path so adblockers
  // don't drop events. EU region is fixed by spec §2 — not env config.
  // skipTrailingSlashRedirect is required for posthog API calls that end in
  // a slash. Trade-off: this disables Next's 308 trailing-slash normalization
  // app-wide, so an externally typed `/tracker/` now 404s instead of
  // redirecting. Acceptable for an invite-gated app — keep monitoring probe
  // URLs slash-free.
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return [
      { source: "/ingest/static/:path*", destination: "https://eu-assets.i.posthog.com/static/:path*" },
      { source: "/ingest/:path*", destination: "https://eu.i.posthog.com/:path*" },
    ];
  },
};
