// Profile typed client — the /profile page (api-contract.md "GET/PUT
// /api/profile"). Never imports server/*; Profile.parse at the boundary.
import { Profile, type RelocationPref } from "@/types";
import { requestJson } from "@/features/http";

export async function getProfile(): Promise<Profile> {
  return requestJson("/api/profile", undefined, Profile);
}

export async function updateProfile(input: { baseCountry: string; relocation: RelocationPref }): Promise<Profile> {
  return requestJson(
    "/api/profile",
    { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
    Profile,
  );
}
