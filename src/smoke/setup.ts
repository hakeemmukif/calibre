// Fail loud: real smoke needs real credentials. No silent skip.
if (!process.env.OPENROUTER_API_KEY) throw new Error("smoke:real requires OPENROUTER_API_KEY (real spend). export OPENROUTER_API_KEY=... and re-run.");
if (!process.env.DATABASE_URL) throw new Error("smoke:real requires DATABASE_URL pointing at a SCRATCH database.");
if (process.env.CALIBER_TEST_DOUBLES) throw new Error("smoke:real must NOT run with CALIBER_TEST_DOUBLES set — it exercises real services.");
