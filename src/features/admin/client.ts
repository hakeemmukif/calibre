// Admin typed client — the /admin users page (Step 6 Task 1's GET
// /api/admin/users). Never imports server/*; mirrors features/profile/client.ts's
// shape (requestJson, .parse the response at the boundary).
import { z } from "zod";
import { AdminUser, AdminUsersResponse, SourcesHealthResponse } from "@/types";
import { requestJson } from "@/features/http";

export async function getAdminUsers(): Promise<AdminUser[]> {
  const result = await requestJson("/api/admin/users", undefined, AdminUsersResponse);
  return result.items;
}

export async function getSourcesHealth(): Promise<SourcesHealthResponse> {
  return requestJson("/api/admin/sources", undefined, SourcesHealthResponse);
}

export async function patchUserPlan(id: string, plan: "standard" | "unlimited"): Promise<AdminUser> {
  return requestJson(
    `/api/admin/users/${id}`,
    { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan }) },
    AdminUser,
  );
}

const GrantResponse = z.object({ balance: z.number().int() });

export async function grantCredits(id: string, delta: number): Promise<number> {
  const result = await requestJson(
    `/api/admin/users/${id}/credits`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ delta }) },
    GrantResponse,
  );
  return result.balance;
}
