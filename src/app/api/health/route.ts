import { NextResponse } from 'next/server';
import { testDoublesEnabled } from '@/lib/llm/client';

export function GET() {
  return NextResponse.json({ ok: true, mode: testDoublesEnabled() ? 'doubles' : 'real' });
}
