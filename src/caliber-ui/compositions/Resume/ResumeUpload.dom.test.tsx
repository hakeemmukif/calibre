// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { ResumeUpload } from './ResumeUpload';

// ResumeUpload's real `error` state (ResumeUpload.tsx): `status: 'error'` +
// `error?: string` render an Icon + message + "Try again" / "Paste text
// instead" Buttons. There is NO injectable `onRetry` callback — "Try again"
// calls the component's own `pick()`, which re-opens the native file input
// (inputRef.current?.click()). Grounded directly in ResumeUpload.tsx.
describe('ResumeUpload error state', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the error message', () => {
    render(<ResumeUpload onFile={vi.fn()} status="error" error="Couldn't parse that file — try a different format." />);
    expect(screen.getByText("Couldn't parse that file — try a different format.")).toBeInTheDocument();
  });

  it('falls back to a default message when no error string is given', () => {
    render(<ResumeUpload onFile={vi.fn()} status="error" />);
    expect(screen.getByText("Couldn't parse that file.")).toBeInTheDocument();
  });

  it('"Try again" re-opens the file picker (no onRetry prop exists on this component)', () => {
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    render(<ResumeUpload onFile={vi.fn()} status="error" error="Parse failed" />);

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('"Paste text instead" reveals the paste textarea', () => {
    render(<ResumeUpload onFile={vi.fn()} status="error" error="Parse failed" />);
    fireEvent.click(screen.getByRole('button', { name: /paste text instead/i }));
    expect(screen.getByPlaceholderText(/paste the plain text of your résumé/i)).toBeInTheDocument();
  });
});
