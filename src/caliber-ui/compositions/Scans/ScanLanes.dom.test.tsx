// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { describe, expect, it, afterEach } from 'vitest';
import { ScanLanes } from './ScanLanes';

// vitest.config.ts runs without `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) never registers — clean up explicitly.
afterEach(cleanup);

describe('ScanLanes', () => {
  it('renders a lane per active job with its phase label and a counts row', () => {
    render(
      <ScanLanes
        activeJobs={[
          { jobId: 'j1', title: 'DE', company: 'Acme', source: 's', phase: 'scoring', slot: 0 },
          { jobId: 'j2', title: 'SRE', company: 'Beta', source: 's', phase: 'readingJD', slot: 1 },
        ]}
        counts={{ scored: 4, queued: 24, total: 30 }}
      />,
    );

    expect(screen.getByText('DE')).toBeInTheDocument();
    expect(screen.getByText(/scoring/i)).toBeInTheDocument();
    expect(screen.getByText(/reading JD/i)).toBeInTheDocument();
    expect(screen.getByText(/4\s*\/\s*30/)).toBeInTheDocument();
  });

  it('derives queued from total - scored - active lanes, ignoring the stored queued', () => {
    render(
      <ScanLanes
        activeJobs={[
          { jobId: 'j1', title: 'DE', company: 'Acme', source: 's', phase: 'scoring', slot: 0 },
          { jobId: 'j2', title: 'SRE', company: 'Beta', source: 's', phase: 'readingJD', slot: 1 },
        ]}
        counts={{ scored: 6, queued: 24, total: 30 }}
      />,
    );

    // 30 total - 6 settled - 2 in-flight lanes = 22 queued (spec §4.4: in-flight
    // jobs are lanes, not queue).
    expect(screen.getByText(/6\s*\/\s*30\s*·\s*22 queued/)).toBeInTheDocument();
  });
});
