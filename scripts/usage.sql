-- Caliber weekly usage report (pre-launch hardening Task 8 — cut to 3 queries;
-- the other five were n=20 noise per the Fable review).
--
-- RUN AGAINST A COPY of the nightly snapshot, NEVER prod:
--   scp box:/backups/caliber-<date>.db /tmp/caliber-usage.db   (or rclone + age -d)
--   sqlite3 /tmp/caliber-usage.db < scripts/usage.sql
--
-- Caveats (schema facts, not bugs):
-- * Timestamps are epoch MILLISECONDS → always /1000 before 'unixepoch'.
-- * job_scores upserts on rescan WITHOUT touching created_at, so any
--   cost-by-day cut of query 2 is lossy. Verdict/legitimacy distribution
--   (query 1) is correct — it wants latest-wins.
.mode box
.headers on

-- 1. Legitimacy/verdict distribution — the wedge-honesty check.
--    If ~99% lands in 'clear', the legitimacy wedge is decorative.
SELECT
  json_extract(legitimacy, '$.tier') AS legitimacy_tier,
  verdict,
  COUNT(*) AS n
FROM job_scores
GROUP BY legitimacy_tier, verdict
ORDER BY n DESC;

-- 2. Cost per user per feature (USD).
SELECT u.email, 'scoring' AS feature, ROUND(SUM(s.cost_usd), 4) AS usd
FROM job_scores s JOIN users u ON u.id = s.user_id GROUP BY u.email
UNION ALL
SELECT u.email, 'url-check', ROUND(SUM(c.cost_usd), 4)
FROM url_checks c JOIN users u ON u.id = c.user_id GROUP BY u.email
UNION ALL
SELECT u.email, 'tailor', ROUND(COALESCE(SUM(t.cost_usd), 0), 4)
FROM tailored_resumes t JOIN users u ON u.id = t.user_id GROUP BY u.email
UNION ALL
SELECT u.email, 'correlate', ROUND(COALESCE(SUM(r.cost_usd), 0), 4)
FROM correlation_reports r JOIN users u ON u.id = r.user_id GROUP BY u.email
UNION ALL
SELECT u.email, 'answers', ROUND(SUM(a.cost_usd), 4)
FROM application_answers a JOIN users u ON u.id = a.user_id GROUP BY u.email
ORDER BY email, usd DESC;

-- 3. Per-user activation funnel (registered → uploaded → scanned → scored →
--    tailored → tracked).
SELECT
  u.email,
  datetime(u.created_at / 1000, 'unixepoch') AS registered_utc,
  (SELECT COUNT(*) FROM resumes r WHERE r.user_id = u.id) AS resumes,
  (SELECT COUNT(*) FROM search_runs sr WHERE sr.user_id = u.id) AS scans,
  (SELECT COUNT(*) FROM job_scores js WHERE js.user_id = u.id) AS scored,
  (SELECT COUNT(*) FROM tailored_resumes t WHERE t.user_id = u.id) AS tailors,
  (SELECT COUNT(*) FROM applications a WHERE a.user_id = u.id) AS applications
FROM users u
ORDER BY u.created_at;
