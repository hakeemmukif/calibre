// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { SourceList } from './SourceList';
import type { Source } from '../../../types';

// vitest.config.ts runs without `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) never registers — clean up explicitly.
afterEach(cleanup);

const testSources: Source[] = [
  { id: 'gh-stripe', name: 'Stripe', kind: 'ats', persona: 'remote', enabled: true },
  { id: 'ashby-ramp', name: 'Ramp', kind: 'ats', persona: 'remote', enabled: false },
  { id: 'jobstreet', name: 'JobStreet Malaysia', kind: 'board', persona: 'local', enabled: true },
];

describe('SourceList persona groups', () => {
  it('renders both persona group headings with their sources', () => {
    render(<SourceList sources={testSources} onToggle={() => {}} />);

    expect(screen.getByText('Remote · global')).toBeInTheDocument();
    expect(screen.getByText('Malaysia · local')).toBeInTheDocument();
    expect(screen.getByText('Stripe')).toBeInTheDocument();
    expect(screen.getByText('Ramp')).toBeInTheDocument();
    expect(screen.getByText('JobStreet Malaysia')).toBeInTheDocument();
  });

  it('renders the kind Tag for ATS and board sources', () => {
    render(<SourceList sources={testSources} onToggle={() => {}} />);

    expect(screen.getAllByText('ATS')).toHaveLength(2);
    expect(screen.getByText('Board')).toBeInTheDocument();
  });
});

describe('SourceList toggle', () => {
  it('calls onToggle with the flipped enabled value when a row control is clicked', () => {
    const onToggle = vi.fn();
    render(<SourceList sources={testSources} onToggle={onToggle} />);

    fireEvent.click(screen.getByRole('button', { name: /toggle stripe/i }));
    expect(onToggle).toHaveBeenCalledWith('gh-stripe', false);

    fireEvent.click(screen.getByRole('button', { name: /toggle ramp/i }));
    expect(onToggle).toHaveBeenCalledWith('ashby-ramp', true);
  });

  it('sets aria-pressed to the row\'s enabled state', () => {
    render(<SourceList sources={testSources} onToggle={() => {}} />);

    expect(screen.getByRole('button', { name: /toggle stripe/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /toggle ramp/i })).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('SourceList busy state', () => {
  it('disables the busyId row\'s control only', () => {
    render(<SourceList sources={testSources} busyId="ashby-ramp" onToggle={() => {}} />);

    expect(screen.getByRole('button', { name: /toggle ramp/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /toggle stripe/i })).not.toBeDisabled();
  });
});
