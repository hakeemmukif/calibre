// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { ScansList } from './ScansList';
import type { SearchRunSummary } from '@/types';

// vitest.config.ts runs without `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) never registers — clean up explicitly.
afterEach(cleanup);

const run: SearchRunSummary = {
  id: 'r1',
  status: 'completed',
  persona: 'remote',
  resumeName: 'jane_v2.pdf',
  startedAt: '2026-07-15T10:00:00.000Z',
  finishedAt: '2026-07-15T10:01:02.000Z',
  stats: { scanned: 40, matched: 30, scored: 28, worth: 6, ghosts: 2, unscored: 1, capStopped: false, discoverMs: 4200, scoreMs: 58000, costUsd: 0.42, policyVersion: 'p3' },
};

describe('ScansList', () => {
  it('renders a run row with résumé, duration, and worth count; opens on click', () => {
    const onOpen = vi.fn();
    render(<ScansList runs={[run]} onOpen={onOpen} />);

    expect(screen.getByText('jane_v2.pdf')).toBeInTheDocument();
    expect(screen.getByText(/6 worth/i)).toBeInTheDocument();

    fireEvent.click(screen.getByText('jane_v2.pdf'));
    expect(onOpen).toHaveBeenCalledWith('r1');
  });

  it('badges a cap-stopped run as partial', () => {
    render(<ScansList runs={[{ ...run, stats: { ...run.stats, capStopped: true } }]} onOpen={() => {}} />);
    expect(screen.getByText(/partial/i)).toBeInTheDocument();
  });

  it('renders a persona tag on the row', () => {
    render(<ScansList runs={[run]} onOpen={() => {}} />);
    expect(screen.getByText('remote')).toBeInTheDocument();
  });
});
