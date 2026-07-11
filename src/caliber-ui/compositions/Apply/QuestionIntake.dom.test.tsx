// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { QuestionIntake } from './QuestionIntake';

// The component-inventory's "extract-failed (retry + manual-add)" state
// (§2) is implemented on QuestionIntake, not ResumeUpload: `error?: string`
// renders the message plus "Retry extraction" (relabelled `onExtract`
// Button) and an "Add questions manually" Button wired to `onManualAdd()`.
// Grounded directly in QuestionIntake.tsx.

// vitest.config.ts runs without `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) never registers — clean up explicitly.
afterEach(cleanup);

describe('QuestionIntake extract-failed state', () => {
  it('renders the error message and an "Add questions manually" control', () => {
    render(
      <QuestionIntake
        mode="paste-jd"
        onModeChange={vi.fn()}
        onExtract={vi.fn()}
        onManualAdd={vi.fn()}
        error="Couldn't find any questions in that text."
      />,
    );

    expect(screen.getByText("Couldn't find any questions in that text.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add questions manually/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry extraction/i })).toBeInTheDocument();
  });

  it('invokes onManualAdd when "Add questions manually" is clicked', () => {
    const onManualAdd = vi.fn();
    render(
      <QuestionIntake
        mode="paste-jd"
        onModeChange={vi.fn()}
        onExtract={vi.fn()}
        onManualAdd={onManualAdd}
        error="Extraction failed"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /add questions manually/i }));
    expect(onManualAdd).toHaveBeenCalledTimes(1);
  });

  it('invokes onExtract with the pasted text when "Retry extraction" is clicked', () => {
    const onExtract = vi.fn();
    render(
      <QuestionIntake
        mode="paste-jd"
        onModeChange={vi.fn()}
        onExtract={onExtract}
        onManualAdd={vi.fn()}
        error="Extraction failed"
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/paste the job description/i), {
      target: { value: 'A job description long enough to pass the 20-char minimum.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /retry extraction/i }));
    expect(onExtract).toHaveBeenCalledWith('paste-jd', 'A job description long enough to pass the 20-char minimum.');
  });
});
