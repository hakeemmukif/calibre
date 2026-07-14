// Auth typed client — login/register/logout (api-contract.md "POST
// /api/auth/register", "POST /api/auth/login", "POST /api/auth/logout").
// Never imports server/*; the session cookie is set by the route response,
// this module only parses the JSON body.
import { z } from "zod";
import { AuthUser, LoginRequest, RegisterRequest, SessionResponse } from "@/types";
import { requestJson } from "@/features/http";

export async function register(input: RegisterRequest): Promise<AuthUser> {
  const { user } = await requestJson(
    "/api/auth/register",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
    SessionResponse,
  );
  return user;
}

export async function login(input: LoginRequest): Promise<AuthUser> {
  const { user } = await requestJson(
    "/api/auth/login",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
    SessionResponse,
  );
  return user;
}

export async function logout(): Promise<void> {
  await requestJson("/api/auth/logout", { method: "POST" }, z.void());
}
