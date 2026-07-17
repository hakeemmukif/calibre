// jobhive CSV ingest — spec 2026-07-16-remote-startup-niche-source-expansion-
// design.md §4.3 step 1 ("vendor the three jobhive CSVs → ~9,935 (name, slug,
// ats, url) rows") and step 3's host trap: "4,848/4,966 greenhouse rows use
// the new `job-boards.greenhouse.io` host — the API host is unaffected, but
// slug-extraction regex must accept both hosts." Vendor schema is
// `name,slug,url` (§3); this module re-derives both `slug` and `ats` from
// `url` via the ATS-signature regexes quoted in §4.3 step 5 rather than
// trusting the CSV's own slug column, so a mislabeled vendor row can never
// silently pass through as the wrong ATS.
//
// The real vendored CSVs (greenhouse/lever/ashby, ~9,935 rows total) are not
// in this repo yet — vendoring them is a separate operator step. This module
// + the fixture in __fixtures__/jobhive-sample.csv are the parser only.

export type JobhiveAts = "greenhouse" | "lever" | "ashby";

export interface JobhiveRow {
  name: string;
  slug: string;
  ats: JobhiveAts;
  url: string;
}

const EXPECTED_HEADER = "name,slug,url";

// Host trap: both `boards.greenhouse.io` and `job-boards.greenhouse.io` must
// resolve to ats "greenhouse" with the same slug.
const GREENHOUSE_RE = /^https?:\/\/(?:boards|job-boards)\.greenhouse\.io\/([\w-]+)/i;
const LEVER_RE = /^https?:\/\/jobs\.lever\.co\/([\w-]+)/i;
const ASHBY_RE = /^https?:\/\/jobs\.ashbyhq\.com\/([\w.-]+)/i;

// Real jobhive company names contain commas inside a quoted field (e.g.
// `"Porter Cares, Inc.",porter,https://...`), so a plain `line.split(",")`
// under-splits. Real data has no `""`-escaped quotes (verified against all
// 9,935 rows), but this state machine handles them anyway since it's no
// extra cost: a `"` toggles quoted mode, `""` inside quotes emits one `"`.
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

function extractAtsSlug(url: string, lineNumber: number): { ats: JobhiveAts; slug: string } {
  const greenhouse = GREENHOUSE_RE.exec(url);
  if (greenhouse) return { ats: "greenhouse", slug: greenhouse[1] };

  const lever = LEVER_RE.exec(url);
  if (lever) return { ats: "lever", slug: lever[1] };

  const ashby = ASHBY_RE.exec(url);
  if (ashby) return { ats: "ashby", slug: ashby[1] };

  throw new Error(`jobhive: row ${lineNumber} has unrecognized ATS host (url=${JSON.stringify(url)})`);
}

/**
 * Parses a vendored jobhive CSV (`name,slug,url` header) into normalized
 * `(name, slug, ats, url)` rows. `slug`/`ats` are re-derived from `url`, not
 * read from the CSV's slug column. Fails loud: throws on a missing/mismatched
 * header, a row with the wrong column count, a missing `name`/`url`, or a
 * `url` whose host isn't a recognized ATS — no silent skip.
 */
export function parseJobhiveCsv(csvText: string): JobhiveRow[] {
  const lines = csvText.split("\n");
  if (lines.length === 0 || lines[0].trim() !== EXPECTED_HEADER) {
    throw new Error(
      `jobhive: unexpected header (want ${JSON.stringify(EXPECTED_HEADER)}, got ${JSON.stringify(lines[0]?.trim() ?? "")})`,
    );
  }

  const rows: JobhiveRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const lineNumber = i + 1;
    const line = lines[i];
    if (line.trim() === "") continue;

    const fields = splitCsvLine(line);
    if (fields.length !== 3) {
      throw new Error(`jobhive: row ${lineNumber} has ${fields.length} column(s), expected 3 (line=${JSON.stringify(line)})`);
    }

    const [rawName, , rawUrl] = fields;
    const name = rawName.trim();
    const url = rawUrl.trim();

    if (!name) {
      throw new Error(`jobhive: row ${lineNumber} missing required field "name" (line=${JSON.stringify(line)})`);
    }
    if (!url) {
      throw new Error(`jobhive: row ${lineNumber} missing required field "url" (line=${JSON.stringify(line)})`);
    }

    const { ats, slug } = extractAtsSlug(url, lineNumber);
    rows.push({ name, slug, ats, url });
  }

  return rows;
}
