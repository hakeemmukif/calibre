/** @type {import('next').NextConfig} */
// `output: "standalone"` bundles a minimal self-contained server (.next/standalone)
// for the Docker image (system-architecture.md §6 deploy). The runtime cwd becomes
// .next/standalone — exactly why résumé uploads root from CALIBER_UPLOADS_DIR
// (Step 5), never process.cwd().
export default { reactStrictMode: true, output: "standalone" };
