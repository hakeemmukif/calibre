import { describe, expect, it, vi } from "vitest";
import type { LlmClient } from "@/lib/llm/client";
import { ingestResume } from "./ingest";
import { NonEnglishResumeError } from "./language";

const BAHASA_MALAYSIA_RESUME = `
Saya bekerja sebagai jurutera perisian di sebuah syarikat teknologi selama lima tahun.
Saya mempunyai kemahiran dalam pengekodan, reka bentuk sistem, serta kerja berpasukan.
Saya juga pernah mengetuai projek pembangunan aplikasi mudah alih untuk pelanggan korporat
serta menyelaraskan keperluan perniagaan dengan pasukan pembangunan yang lain.
`;

describe("ingestResume — English-first reject gate", () => {
  it("rejects a non-English pasted résumé before any LLM call", async () => {
    const complete = vi.fn();
    const llm = { complete } as unknown as LlmClient;

    await expect(ingestResume("user-1", { text: BAHASA_MALAYSIA_RESUME }, { llm })).rejects.toThrow(
      NonEnglishResumeError,
    );
    expect(complete).not.toHaveBeenCalled();
  });
});
