# Caliber app image. Multi-stage: build with a Node image, run on the Playwright
# base image (Chromium + system deps baked in) because src/lib/pdf.ts renders
# résumé PDFs in-process via playwright-chromium (system-architecture.md §6 dec 5).
#
# ⚠️ NOT built/validated in the migration dev environment (no Docker). Validate on
# the target host: `docker build -t caliber .` then the DEPLOY.md smoke.
#
# Pin the Playwright image tag to the `playwright` version in package.json
# (currently ^1.61.1) — the browser bundled in the image must match the client.

# ---- build stage ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The build does not connect to the DB (getDb is lazy); a placeholder satisfies
# any module that reads DATABASE_URL at import time.
ENV DATABASE_URL=file:/tmp/build-placeholder.db
RUN npm run build

# ---- runtime stage ----
# Playwright image = Chromium + all system libs already installed.
FROM mcr.microsoft.com/playwright:v1.61.1-noble AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Exactly ONE app process (in-memory SSE run-registry + single url-check worker,
# started by src/instrumentation.ts register()). Do NOT run a cluster/replicas.
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.mjs ./
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/drizzle.config.ts ./
# config/ is read from disk at RUNTIME: src/lib/llm/models.ts + templates.ts do
# readFileSync(cwd()/config/...) per LLM call. `output: standalone` cannot trace
# these dynamic fs reads, so they are NOT bundled — copy config/ explicitly or
# every scoring/tailor/extract call ENOENTs.
COPY --from=build /app/config ./config
# src/ is needed by the runbook's tsx one-offs: `npm run db:seed`
# (tsx src/server/persistence/seed.ts) and the uploads migration
# (tsx src/server/resume/migrate-uploads.ts).
COPY --from=build /app/src ./src
# tsconfig.json: those tsx one-offs import via the `@/*` -> `./src/*` path alias,
# which tsx only resolves when tsconfig.json is present at the runtime cwd.
COPY --from=build /app/tsconfig.json ./
# Uploads root (Step 5) + SQLite db dir — persisted via named volumes in compose.
# Create the dirs so the app can write even before the mounts (they overlay these).
RUN mkdir -p /var/lib/caliber/uploads /var/lib/caliber/data
EXPOSE 3000
# `next start` (robust). Standalone (`node .next/standalone/server.js`) is a
# slimmer alternative once validated on a clean build — see DEPLOY.md.
CMD ["npm", "run", "start", "--", "-p", "3000", "-H", "0.0.0.0"]
