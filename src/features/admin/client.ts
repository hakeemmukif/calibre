// Admin typed client — the /admin users page (Step 6 Task 1's GET
// /api/admin/users). Never imports server/*; mirrors features/profile/client.ts's
// shape (requestJson, .parse the response at the boundary).
import { AdminUsersResponse, type AdminUser } from "@/types";
import { requestJson } from "@/features/http";

export async function getAdminUsers(): Promise<AdminUser[]> {
  const result = await requestJson("/api/admin/users", undefined, AdminUsersResponse);
  return result.items;
}
