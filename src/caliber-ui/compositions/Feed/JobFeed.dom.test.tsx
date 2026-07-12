// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { JobFeed } from './JobFeed';
import type { SummaryStripStats } from '../../../types';

// JobFeed's real `error+retry` state (JobFeed.tsx): `error?: string` +
// `onRetry?(): void` render an Icon + message + a "Retry" Button when
// `!loading && error`. Grounded directly in JobFeed.tsx, not the inventory doc.
const zeroStats: SummaryStripStats = { scanned: 0, worth: 0, ghosts: 0, flagged: 0, sinceLast: 0, excluded: 0 };

// vitest.config.ts runs without `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) never registers — clean up explicitly.
afterEach(cleanup);

describe('JobFeed error+retry state', () => {
  it('renders the error message instead of the job list', () => {
    render(
      <JobFeed
        jobs={[]}
        filter="all"
        onFilterChange={vi.fn()}
        stats={zeroStats}
        loading={false}
        error="Couldn't reach the scan service. Check your connection and try again."
        onRowAction={vi.fn()}
      />,
    );

    expect(screen.getByText("Couldn't reach the scan service. Check your connection and try again.")).toBeInTheDocument();
  });

  it('invokes onRetry when the Retry button is clicked', () => {
    const onRetry = vi.fn();
    render(
      <JobFeed
        jobs={[]}
        filter="all"
        onFilterChange={vi.fn()}
        stats={zeroStats}
        loading={false}
        error="Scan failed"
        onRetry={onRetry}
        onRowAction={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("JobFeed 'Work anywhere' chip (spec §8, §11.8 chip swap)", () => {
  it("filters to eligibility.tier === 'anywhere' rows only", async () => {
    const { jobs } = await import('../../fixtures');
    const anywhereCount = jobs.filter((j) => j.eligibility.tier === 'anywhere').length;
    const anywhereJob = jobs.find((j) => j.eligibility.tier === 'anywhere');
    const otherJob = jobs.find((j) => j.eligibility.tier !== 'anywhere');
    if (!anywhereJob || !otherJob) throw new Error('fixtures must cover anywhere + non-anywhere tiers');

    render(
      <JobFeed
        jobs={jobs}
        filter="anywhere"
        onFilterChange={vi.fn()}
        stats={zeroStats}
        loading={false}
        onRowAction={vi.fn()}
      />,
    );

    expect(screen.getByText(`Work anywhere · ${anywhereCount}`)).toBeInTheDocument();
    expect(screen.getByText(anywhereJob.role)).toBeInTheDocument();
    expect(screen.queryByText(otherJob.role)).not.toBeInTheDocument();
  });
});
