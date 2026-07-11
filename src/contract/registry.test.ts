import { describe, it, expect } from 'vitest';
import { buildDocument, serializeDocument } from './generate';

describe('contract document', () => {
  it('has required top-level OpenAPI 3.1 keys', () => {
    const doc = buildDocument();
    expect(doc.openapi.startsWith('3.1')).toBe(true);
    expect(doc.info).toBeDefined();
    expect(doc.paths).toBeDefined();
    expect(doc.components).toBeDefined();
  });

  it('registers a component schema for the representative frozen entities', () => {
    const doc = buildDocument();
    const schemas = doc.components?.schemas ?? {};
    for (const name of ['Job', 'Resume', 'Application', 'SearchRun', 'TailoredResume', 'ErrorEnvelope']) {
      expect(schemas[name], `missing component schema: ${name}`).toBeDefined();
    }
  });

  it('registers all 17 frozen entities as component schemas', () => {
    const doc = buildDocument();
    const schemas = doc.components?.schemas ?? {};
    const names = [
      'Persona', 'LegitimacyTier', 'Tone', 'Legitimacy', 'SourceRef', 'Job', 'Resume',
      'RunStatus', 'Progress', 'SearchRun', 'Application', 'ApplicationQuestion',
      'ApplicationAnswer', 'ApplicationAnswers', 'TailoredResume', 'ErrorEnvelope', 'SummaryStripStats',
    ];
    for (const name of names) {
      expect(schemas[name], `missing component schema: ${name}`).toBeDefined();
    }
  });

  it('includes the GET /api/health path with a 200 response', () => {
    const doc = buildDocument();
    const health = doc.paths?.['/api/health'];
    expect(health?.get).toBeDefined();
    expect(health?.get?.responses?.['200']).toBeDefined();
  });

  it('carries the v1 auth-none note in info', () => {
    const doc = buildDocument();
    const description = (doc.info.description ?? '').toLowerCase();
    expect(description).toContain('auth');
    expect(description).toContain('none');
  });

  it('produces byte-identical serialized output across builds', () => {
    const first = serializeDocument(buildDocument());
    const second = serializeDocument(buildDocument());
    expect(first).toBe(second);
  });

  it("ErrorEnvelope code enum includes INTERNAL for run-crash failures", async () => {
    const { ErrorEnvelope } = await import("@/types");
    const codes = ErrorEnvelope.shape.error.shape.code.options;
    expect(codes).toContain("INTERNAL");
  });
});
