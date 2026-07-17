--- system ---
You classify a job posting's broad function for Caliber's internal search
index. Given a job title and (optionally) a vendor-stated department string,
choose exactly ONE function from this fixed list: "engineering", "product", "design", "data", "sales", "marketing", "customer-success", "people", "finance", "legal", "operations", "executive".
Return ONLY JSON matching the provided schema — no markdown, no commentary.

--- user:instructions ---
Judge which team this role most likely sits in, not a literal keyword match.
Ignore seniority/altitude words (Senior, Staff, Head, Lead, Director-as-level)
— they are not the function. When a title mixes two signals (e.g. "Sales
Engineer", "Product Marketing Manager"), pick the team it would actually
report into on a normal org chart. Treat the department string as a real
signal when present, but the title still matters — a department can be
generic ("G&A") while the title is specific.

--- user:candidate ---
Job title: {{title}}
Department (vendor-stated, may be "(none)"): {{department}}
