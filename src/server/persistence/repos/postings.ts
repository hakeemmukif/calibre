import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { ScanPersona } from "@/types";
import { getDb } from "../db";
import { postings } from "../schema";
import type { Db } from "./db";

export type NewPosting = typeof postings.$inferInsert;
export type PostingRow = typeof postings.$inferSelect;

// Stage-1 matching projection (arch §1.2). The column list is CLOSED and
// deliberately omits the read-amplifying columns — `description` (avg ~4.3 KB,
// a stage-1 SELECT * would drag ~120 MB/scan for a column it never reads),
// `raw`, and `aliases` (the json blobs). It DOES include `department` (P.4's
// tag input — a short string, no amplification) and the light admission
// scalars (`url`/`applyUrl`/`externalId`/`salaryRaw`) the pool-read path (P.5)
// needs to materialize a `jobs` row: arch §1.2 names only description/raw/
// aliases as the intended exclusions, and §3.4 admission requires `url`.
// A test pins this shape (postings.test.ts) — the same
// query-text enforcement style as no-db-transaction.test.ts.
export const listForMatchingProjection = {
  id: postings.id,
  canonicalKey: postings.canonicalKey,
  url: postings.url,
  applyUrl: postings.applyUrl,
  sourceId: postings.sourceId,
  externalId: postings.externalId,
  title: postings.title,
  company: postings.company,
  location: postings.location,
  salaryRaw: postings.salaryRaw,
  postedAt: postings.postedAt,
  firstSeenAt: postings.firstSeenAt,
  persona: postings.persona,
  tzBand: postings.tzBand,
  functionTag: postings.functionTag,
  functionTagVersion: postings.functionTagVersion,
  department: postings.department,
} as const;

// Inferred from the projection so column nullability is preserved exactly
// (a hand-mapped type over `["_"]["data"]` drops the `| null` on nullable
// columns like applyUrl/tzBand). No runtime db is needed for the type.
function buildMatchSelect(db: Db) {
  return db.select(listForMatchingProjection).from(postings);
}
export type PostingMatchRow = Awaited<ReturnType<typeof buildMatchSelect>>[number];

export function createPostingsRepo(db: Db) {
  return {
    // GLOBAL-BY-DECISION: `postings` is the system-owned shared pool (arch §1 —
    // no userId column by design); every read/write here is intentionally
    // cross-tenant. Per-user isolation lives one layer up in `jobs` (admission).
    // Live-pool stage-1 read (arch §3.2): the projection above (NO description),
    // live rows only (delistedAt IS NULL — the partial index covers this), and
    // persona-scoped. A `remote` scan sees `remote` + `both` postings; a `local`
    // scan sees `local` + `both` — `both` postings are relevant to either slot
    // (the source-level persona copied at crawl, arch §1.1). No `db.transaction`.
    async listForMatching(persona: ScanPersona): Promise<PostingMatchRow[]> {
      return buildMatchSelect(db).where(
        and(isNull(postings.delistedAt), or(eq(postings.persona, persona), eq(postings.persona, "both"))),
      );
    },

    // GLOBAL-BY-DECISION: global pool read (see listForMatching) — postings has
    // no userId; scoping is the caller's (P.5 only passes ids it just admitted).
    // Deep-score read (arch §1.2 / §3 step 6): full rows INCLUDING description,
    // only ever called with the ≤TOP_N admitted candidate ids. Empty input is a
    // no-op (drizzle would otherwise emit an invalid IN ()). Returns only the
    // rows that still exist — a posting purged (arch §2.5) between admission and
    // scoring simply isn't returned; the caller scores what it gets.
    async getForScoring(ids: string[]): Promise<PostingRow[]> {
      if (ids.length === 0) return [];
      return db.select().from(postings).where(inArray(postings.id, ids));
    },

    // GLOBAL-BY-DECISION: global pool write — postings has no userId; the
    // function tag is posting-intrinsic (not per-user), so the cache is shared.
    // Function-classifier write-back cache (arch §3.3, P.4): the first scan to
    // surface an unclassified posting classifies it and persists the tag +
    // classifier version here, so every later user reads the cache instead of
    // re-paying the LLM call. `version` drives the re-tag gate (arch §9) on a
    // classifier-version bump. Unknown id throws — a write-back for a vanished
    // posting is a bug, not a silent no-op (mirrors jobsRepo.updateEligibility).
    async setFunctionTag(id: string, tag: string, version: string): Promise<void> {
      const [row] = await db
        .update(postings)
        .set({ functionTag: tag, functionTagVersion: version })
        .where(eq(postings.id, id))
        .returning({ id: postings.id });
      if (!row) throw new Error(`postingsRepo.setFunctionTag: no posting with id "${id}"`);
    },
  };
}

export const postingsRepo: ReturnType<typeof createPostingsRepo> = {
  listForMatching: (persona) => createPostingsRepo(getDb()).listForMatching(persona),
  getForScoring: (ids) => createPostingsRepo(getDb()).getForScoring(ids),
  setFunctionTag: (id, tag, version) => createPostingsRepo(getDb()).setFunctionTag(id, tag, version),
};
