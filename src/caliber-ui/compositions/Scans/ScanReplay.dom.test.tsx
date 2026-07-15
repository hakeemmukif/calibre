// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, expect, it, afterEach } from 'vitest';
import { ScanReplay } from './ScanReplay';
import type { ScanDetail } from '../../../types';

// vitest.config.ts runs without `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) never registers — clean up explicitly.
afterEach(cleanup);

const detailFixture: ScanDetail = {
  id: 'run-1',
  status: 'completed',
  persona: 'remote',
  resumeName: 'jane_v2.pdf',
  startedAt: '2026-07-15T08:00:00.000Z',
  finishedAt: '2026-07-15T08:02:00.000Z',
  error: null,
  stats: {
    scanned: 40,
    matched: 30,
    scored: 28,
    worth: 6,
    ghosts: 2,
    unscored: 1,
    capStopped: false,
    discoverMs: 4200,
    scoreMs: 58000,
    costUsd: 0.42,
    policyVersion: 'p3',
  },
  results: [
    { jobId: 'j1', title: 'Data Engineer', company: 'Acme', source: 'greenhouse', outcome: 'scored', verdict: 'Apply', legitimacyTier: 'clear', fit: 3.2, scoredMs: 1200 },
    { jobId: 'j2', title: 'Backend Engineer', company: 'Beta', source: 'lever', outcome: 'scored', verdict: 'Consider', legitimacyTier: 'ghost', fit: 4.6, scoredMs: 900 },
    { jobId: 'j3', title: 'Platform Engineer', company: 'Gamma', source: 'ashby', outcome: 'scored', verdict: 'Skip', legitimacyTier: 'ghost', fit: 1.8, scoredMs: 1100 },
    { jobId: 'j4', title: 'Infra Engineer', company: 'Delta', source: 'greenhouse', outcome: 'unscored' },
    { jobId: 'j5', title: 'SRE', company: 'Epsilon', source: 'lever', outcome: 'error', error: 'fetch timeout' },
    { jobId: 'j6', title: 'DevOps', company: 'Zeta', source: 'ashby', outcome: 'skipped', reason: 'dailyCap' },
  ],
};

describe('ScanReplay header', () => {
  it('renders header stats and a fit-sorted score list', () => {
    render(<ScanReplay detail={detailFixture} />);
    expect(screen.getByText('jane_v2.pdf')).toBeInTheDocument();
    expect(screen.getByText(/\$0\.42/)).toBeInTheDocument();
    const rows = screen.getAllByTestId('score-row');
    const fits = rows.map((r) => Number(r.getAttribute('data-fit')));
    expect(fits).toEqual([...fits].sort((a, b) => b - a)); // descending
  });
});

describe('ScanReplay score list sorting', () => {
  it('re-sorts by verdict when the sort control is switched', () => {
    render(<ScanReplay detail={detailFixture} />);
    fireEvent.click(screen.getByRole('button', { name: /verdict/i }));
    const rows = screen.getAllByTestId('score-row');
    expect(rows.map((r) => r.getAttribute('data-job-id'))).toEqual(['j1', 'j2', 'j3']); // Apply, Consider, Skip
  });
});

describe('ScanReplay discover per-source breakdown', () => {
  it('renders a row per source with found/error counts', () => {
    const detail: ScanDetail = {
      ...detailFixture,
      stats: {
        ...detailFixture.stats,
        perSource: [
          { sourceId: 'greenhouse', found: 5, errors: 0 },
          { sourceId: 'lever', found: 2, errors: 1 },
        ],
      },
    };
    render(<ScanReplay detail={detail} />);
    expect(screen.getByText('greenhouse')).toBeInTheDocument();
    expect(screen.getByText('5 found')).toBeInTheDocument();
    expect(screen.getByText('0 errors')).toBeInTheDocument();
    expect(screen.getByText('lever')).toBeInTheDocument();
    expect(screen.getByText('2 found')).toBeInTheDocument();
    expect(screen.getByText('1 error')).toBeInTheDocument();
  });
});

describe('ScanReplay legitimacy aggregate', () => {
  it('aggregates results by legitimacy tier', () => {
    render(<ScanReplay detail={detailFixture} />);
    expect(screen.getByText(/2 ghost/i)).toBeInTheDocument();
    expect(screen.getByText(/1 clear/i)).toBeInTheDocument();
  });
});
