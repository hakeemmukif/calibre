// GET /api/sources — Sources management page: ALL rows, both personas,
// disabled included, ordered by name. `Source` (src/types) is the full DB
// row shape; `SourceRef` stays the slim per-job ref embedded in `Job.source`.
import { NextResponse } from "next/server";
import { sourcesRepo } from "@/server/persistence/repos/sources";
import { Source } from "@/types";

export async function GET() {
  const rows = await sourcesRepo.listAll();
  const items = rows.map((row) => Source.parse(row));
  return NextResponse.json({ items }, { status: 200 });
}
