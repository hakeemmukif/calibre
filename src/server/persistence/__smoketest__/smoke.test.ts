import { describe, it, expect } from 'vitest';
import { createTestDb } from '../test-db';
import { sources } from '../schema';

describe('smoke', () => {
  it('applies migrations and inserts', async () => {
    const db = await createTestDb();
    const [row] = await db.insert(sources).values({ id: 'greenhouse', name: 'Greenhouse', kind: 'ats', persona: 'both', enabled: true, config: {} }).returning();
    expect(row.id).toBe('greenhouse');
  });
});
