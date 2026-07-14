import { describe, expect, it } from "vitest";
import { assertEnglish, NonEnglishResumeError } from "./language";

const ENGLISH_SNIPPET_SHORT = "Software engineer with experience in TypeScript and Node.js.";

const ENGLISH_RESUME = `
Jane Doe
Senior Backend Engineer

Summary
Backend engineer with six years of experience building distributed systems at scale.
Skilled in designing APIs, leading teams, and shipping reliable software.

Experience
Acme Co — Senior Backend Engineer, 2022–Present
Led migration to Kubernetes and mentored a team of four engineers.

Education
University of Malaya — BSc Computer Science

Skills
TypeScript, Go, PostgreSQL, distributed systems, team leadership
`;

const CHINESE_RESUME = `
我是一名软件工程师，拥有五年工作经验，擅长后端开发和系统设计。
曾在多家科技公司担任高级工程师职务，负责团队管理与项目交付。
熟悉分布式系统架构，具备良好的沟通与协作能力，致力于持续学习与技术创新。
`;

const BAHASA_MALAYSIA_RESUME = `
Saya bekerja sebagai jurutera perisian di sebuah syarikat teknologi selama lima tahun.
Saya mempunyai kemahiran dalam pengekodan, reka bentuk sistem, serta kerja berpasukan.
Saya juga pernah mengetuai projek pembangunan aplikasi mudah alih untuk pelanggan korporat
serta menyelaraskan keperluan perniagaan dengan pasukan pembangunan yang lain.
`;

describe("assertEnglish", () => {
  it("passes a normal English résumé", () => {
    expect(() => assertEnglish(ENGLISH_RESUME)).not.toThrow();
  });

  it("does not throw on a short English snippet (< 200 chars)", () => {
    expect(ENGLISH_SNIPPET_SHORT.length).toBeLessThan(200);
    expect(() => assertEnglish(ENGLISH_SNIPPET_SHORT)).not.toThrow();
  });

  it("throws NonEnglishResumeError for a Chinese/CJK résumé", () => {
    expect(() => assertEnglish(CHINESE_RESUME)).toThrow(NonEnglishResumeError);
  });

  it("throws NonEnglishResumeError for a Bahasa Malaysia résumé (Latin script, few English words, ≥200 chars)", () => {
    expect(BAHASA_MALAYSIA_RESUME.length).toBeGreaterThanOrEqual(200);
    expect(() => assertEnglish(BAHASA_MALAYSIA_RESUME)).toThrow(NonEnglishResumeError);
  });
});
