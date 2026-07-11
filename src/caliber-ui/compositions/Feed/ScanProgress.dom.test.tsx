// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { ScanProgress, type ScanProgressStageRow } from './ScanProgress';

// vitest.config.ts runs without `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) never registers — clean up explicitly.
afterEach(cleanup);

const runningStages: ScanProgressStageRow[] = [
  { stage: 'discover', label: 'Finding jobs across boards', state: 'done' },
  { stage: 'extract', label: 'Reading job descriptions', state: 'done' },
  { stage: 'score', label: 'Scoring fit and legitimacy', state: 'active', current: 4, total: 30, detail: '4/30 scored' },
  { stage: 'finalize', label: 'Finalizing your feed', state: 'pending' },
];

const doneStages: ScanProgressStageRow[] = runningStages.map((s) => ({ ...s, state: 'done', detail: undefined }));

describe('ScanProgress running state', () => {
  it('renders all four passed stage labels and no summary/close button', () => {
    render(<ScanProgress status="running" stages={runningStages} />);

    expect(screen.getByText('Finding jobs across boards')).toBeInTheDocument();
    expect(screen.getByText('Reading job descriptions')).toBeInTheDocument();
    expect(screen.getByText('Scoring fit and legitimacy')).toBeInTheDocument();
    expect(screen.getByText('Finalizing your feed')).toBeInTheDocument();

    expect(screen.queryByText(/flagged ghost/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /view your matches/i })).not.toBeInTheDocument();
  });

  it('shows the detail sub-label for the active row', () => {
    render(<ScanProgress status="running" stages={runningStages} />);

    expect(screen.getByText('4/30 scored')).toBeInTheDocument();
  });
});

describe('ScanProgress done state', () => {
  it('renders the honest summary numbers from stats and calls onClose from "View your matches"', () => {
    const onClose = vi.fn();
    render(
      <ScanProgress
        status="done"
        stages={doneStages}
        stats={{ scanned: 112, worth: 9, ghosts: 13 }}
        onClose={onClose}
      />,
    );

    expect(screen.getByText('112 scanned')).toBeInTheDocument();
    expect(screen.getByText('9 worth your time')).toBeInTheDocument();
    expect(screen.getByText('13 flagged ghost')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /view your matches/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ScanProgress error state', () => {
  it('renders the error string and not the done-state success summary', () => {
    render(
      <ScanProgress
        status="error"
        stages={runningStages}
        error="Couldn't reach the scan service. Check your connection and try again."
      />,
    );

    expect(
      screen.getByText("Couldn't reach the scan service. Check your connection and try again."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/flagged ghost/i)).not.toBeInTheDocument();
  });
});
