// GET /api/credits — wallet balance + plan for the header chip (membership
// spec §4.2). No debit here; this is a plain read.
import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { UnauthorizedError } from "@/server/auth/errors";
import { balance } from "@/server/credits";
import { usersRepo } from "@/server/persistence/repos/users";
import { CreditsResponse } from "@/types";

export async function GET() {
  try {
    const session = await requireUser();
    const user = await usersRepo.findById(session.id);
    if (!user) throw new Error(`credits: session user ${session.id} has no users row`);
    return NextResponse.json(CreditsResponse.parse({ balance: await balance(session.id), plan: user.plan }));
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Sign in required." } }, { status: 401 });
    }
    throw err;
  }
}
