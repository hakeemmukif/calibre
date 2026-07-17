// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { JobDetail } from './JobDetail';
import { jobs } from '../../fixtures';

// JobDetail's optional Re-evaluate action (Task 9): `onEvaluate?: () => void`
// + `evaluateStatus?: "idle" | "evaluating" | "error"`. The button renders
// only when `onEvaluate` is supplied (mirrors AnswerCard's `onRetry` optional
// render-slot precedent, AnswerCard.dom.test.tsx). Grounded in JobDetail.tsx.

// vitest.config.ts runs without `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) never registers — clean up explicitly.
afterEach(cleanup);

const job = jobs.find((j) => j.id === 'job-grab-backend')!;

function renderDetail(props: Partial<React.ComponentProps<typeof JobDetail>> = {}) {
  return render(
    <JobDetail
      job={job}
      onApply={vi.fn()}
      onTailor={vi.fn()}
      onAnswerQuestions={vi.fn()}
      onMarkApplied={vi.fn().mockResolvedValue(undefined)}
      {...props}
    />,
  );
}

describe('JobDetail Re-evaluate action', () => {
  it('does not render the Re-evaluate button when onEvaluate is omitted', () => {
    renderDetail();
    expect(screen.queryByRole('button', { name: /re-evaluate/i })).not.toBeInTheDocument();
  });

  it('renders the Re-evaluate button when onEvaluate is given', () => {
    renderDetail({ onEvaluate: vi.fn() });
    expect(screen.getByRole('button', { name: /^re-evaluate$/i })).toBeInTheDocument();
  });

  it('invokes onEvaluate when clicked', () => {
    const onEvaluate = vi.fn();
    renderDetail({ onEvaluate });
    fireEvent.click(screen.getByRole('button', { name: /^re-evaluate$/i }));
    expect(onEvaluate).toHaveBeenCalledTimes(1);
  });

  it('shows "Re-evaluating…" and disables the button while evaluating', () => {
    renderDetail({ onEvaluate: vi.fn(), evaluateStatus: 'evaluating' });
    const button = screen.getByRole('button', { name: /re-evaluating/i });
    expect(button).toBeDisabled();
  });

  it('shows an inline error line when evaluateStatus is error', () => {
    renderDetail({ onEvaluate: vi.fn(), evaluateStatus: 'error' });
    expect(screen.getByText(/couldn't re-evaluate/i)).toBeInTheDocument();
    // The button stays enabled so the user can retry by clicking it again.
    expect(screen.getByRole('button', { name: /^re-evaluate$/i })).toBeEnabled();
  });
});

describe('JobDetail verdict-feedback link (Task 7)', () => {
  it('renders the quiet verdict-feedback link (Task 7)', () => {
    renderDetail();
    const link = screen.getByRole('link', { name: /verdict look wrong/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('https://t.me/share/url?'));
  });
});
