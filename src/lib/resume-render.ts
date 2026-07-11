// F6 tailor — deterministic ResumeStore -> HTML render (donor `renderCvHtml`,
// rebuilt clean per system-architecture.md §2 "server/tailor" row: "LaTeX
// DROPPED"). Pure and leaf-level: no I/O, no Playwright — `lib/pdf.ts` turns
// this HTML into a PDF. Same store in -> same string out; every field is
// HTML-escaped so résumé content (candidate-controlled) can never break out
// of the markup.
import type { ResumeStore } from "@/server/resume/resume-store";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderCvHtml(store: ResumeStore): string {
  const contactHtml = store.contact
    .map((c) => `<li>${escapeHtml(c.label)}: ${escapeHtml(c.value)}</li>`)
    .join("");

  const experienceHtml = store.experience
    .map(
      (e) => `<section class="experience-entry">
  <h3>${escapeHtml(e.title)} — ${escapeHtml(e.company)}</h3>
  <p class="dates">${escapeHtml(e.dates)}${e.location ? ` · ${escapeHtml(e.location)}` : ""}</p>
  <ul>${e.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>
</section>`,
    )
    .join("");

  const educationHtml = store.education
    .map((ed) => `<li>${escapeHtml(ed.credential)}, ${escapeHtml(ed.school)} (${escapeHtml(ed.dates)})</li>`)
    .join("");

  const skillsHtml = store.skills
    .map(
      (g) => `<div class="skill-group">
  <h4>${escapeHtml(g.label)}</h4>
  <p>${g.items.map(escapeHtml).join(", ")}</p>
</div>`,
    )
    .join("");

  const extrasHtml = store.extras.map((x) => `<li>${escapeHtml(x)}</li>`).join("");

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${escapeHtml(store.name)}</title></head>
<body>
<h1>${escapeHtml(store.name)}</h1>
<ul class="contact">${contactHtml}</ul>
<section class="summary"><p>${escapeHtml(store.summary)}</p></section>
<section class="experience">${experienceHtml}</section>
<section class="education"><ul>${educationHtml}</ul></section>
<section class="skills">${skillsHtml}</section>
<section class="extras"><ul>${extrasHtml}</ul></section>
</body>
</html>`;
}
