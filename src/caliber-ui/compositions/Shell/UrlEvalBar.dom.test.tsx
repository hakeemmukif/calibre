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
