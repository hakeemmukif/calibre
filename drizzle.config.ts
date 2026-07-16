import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

// drizzle-kit (unlike Next) doesn't auto-load .env.local; load it natively so
// `npm run db:migrate` works without an inline export. No-op when absent —
// CI/prod supply DATABASE_URL from the real environment.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/persistence/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url,
  },
});
