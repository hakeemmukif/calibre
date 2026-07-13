// Fixed well-known UUID for the bootstrap admin. seed.ts inserts/updates this
// row from ADMIN_EMAIL/ADMIN_PASSWORD; Step 2's user_id backfill migration
// assigns all pre-existing single-user rows to this id. Never regenerate it.
export const BOOTSTRAP_ADMIN_ID = "00000000-0000-4000-8000-000000000001";
