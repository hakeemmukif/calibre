// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { AppliedButton } from './AppliedButton';

// AppliedButton has no injectable `error`/`onRetry` prop — `error-retry` is
// internal state (AppliedButton.tsx: `phase` local state) entered when the
// `onMarkApplied()` promise rejects, and "Retry" re-invokes the same
// `onMarkApplied` handler (handleClick), not a separate callback. Grounded
// directly in AppliedButton.tsx.

// vitest.config.ts runs without `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) never registers — clean up explicitly.
afterEach(cleanup);

describe('AppliedButton error-retry state', () => {
  it('shows the error message and a Retry control when onMarkApplied rejects', async () => {
    const onMarkApplied = vi.fn().mockRejectedValue(new Error('network down'));
    render(<AppliedButton applied={false} onMarkApplied={onMarkApplied} />);

    fireEvent.click(screen.getByRole('button', { name: /mark as applied/i }));

    await waitFor(() => {
      expect(screen.getByText(/couldn't save/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(onMarkApplied).toHaveBeenCalledTimes(1);
  });

  it('re-invokes onMarkApplied when Retry is clicked', async () => {
    const onMarkApplied = vi.fn().mockRejectedValue(new Error('network down'));
    render(<AppliedButton applied={false} onMarkApplied={onMarkApplied} />);

    fireEvent.click(screen.getByRole('button', { name: /mark as applied/i }));
    await waitFor(() => screen.getByRole('button', { name: /retry/i }));

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => {
      expect(onMarkApplied).toHaveBeenCalledTimes(2);
    });
  });
});
