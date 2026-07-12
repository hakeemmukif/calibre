// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { UrlEvalBar } from './UrlEvalBar';

afterEach(cleanup);

describe('UrlEvalBar idle/evaluating/success', () => {
  it('idle: Check is disabled on empty URL, enabled once a URL is typed; no error/stage text', () => {
    render(<UrlEvalBar status="idle" onSubmit={vi.fn()} />);
    const input = screen.getByLabelText('Job posting URL');
    expect(input).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check' })).toBeDisabled();
    fireEvent.change(input, { target: { value: 'https://example.com/jobs/1' } });
    expect(screen.getByRole('button', { name: 'Check' })).toBeEnabled();
    expect(screen.queryByText(/checking/i)).not.toBeInTheDocument();
  });

  it('evaluating shows the stageText line and disables input/button', () => {
    render(<UrlEvalBar status="evaluating" stageText="Reading the posting…" onSubmit={vi.fn()} />);
    expect(screen.getByText('Reading the posting…')).toBeInTheDocument();
    expect(screen.getByLabelText('Job posting URL')).toBeDisabled();
    expect(screen.getByRole('button', { name: /checking/i })).toBeDisabled();
  });

  it('success renders no error row', () => {
    render(<UrlEvalBar status="success" onSubmit={vi.fn()} />);
    expect(screen.queryByText(/./, { selector: '[role="alert"]' })).not.toBeInTheDocument();
  });
});

describe('UrlEvalBar paste-box (needsText)', () => {
  it('shows no textarea when showPasteBox is falsy/omitted', () => {
    render(<UrlEvalBar status="error" error="Could not read that page." onSubmit={vi.fn()} />);
    expect(screen.queryByRole('textbox', { name: /paste/i })).not.toBeInTheDocument();
  });

  it('reveals a textarea when showPasteBox is true, and re-submit sends {url, text}', () => {
    const onSubmit = vi.fn();
    render(
      <UrlEvalBar
        status="error"
        error="Could not read that page — paste the posting text instead."
        showPasteBox
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText('Job posting URL'), { target: { value: 'https://example.com/job/1' } });
    const textarea = screen.getByLabelText(/paste the job posting text/i);
    fireEvent.change(textarea, { target: { value: 'Senior Engineer — Acme Corp — full JD text…' } });
    fireEvent.click(screen.getByRole('button', { name: /check/i }));

    expect(onSubmit).toHaveBeenCalledWith('https://example.com/job/1', 'Senior Engineer — Acme Corp — full JD text…');
  });

  it('re-submit button stays disabled until both url and pasted text are non-empty', () => {
    render(<UrlEvalBar status="error" error="needs text" showPasteBox onSubmit={vi.fn()} />);
    expect(screen.getByRole('button', { name: /check/i })).toBeDisabled();
  });
});
