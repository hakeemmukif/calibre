// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { AnswerCard } from './AnswerCard';
import { resume, questions, answers } from '../../fixtures';

// ApplyQuestionsAssistant's per-card error state lives in AnswerCard.tsx:
// `status: AnswerDraftStatus` includes `'error'`, rendering "Couldn't draft
// this answer." plus a "Retry" Button wired to the optional `onRetry?(): void`
// prop (only rendered `{onRetry && ...}`). Grounded directly in AnswerCard.tsx.

// vitest.config.ts runs without `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) never registers — clean up explicitly.
afterEach(cleanup);

describe('AnswerCard per-card error state', () => {
  it('renders the draft-failed message and tag', () => {
    render(
      <AnswerCard
        question={questions[0]}
        answer={{ ...answers.answers[0], answer: '' }}
        resume={resume}
        status="error"
        onChangeText={vi.fn()}
        onRegenerate={vi.fn()}
        onCopy={vi.fn()}
        onSelectGrounding={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText("Couldn't draft this answer.")).toBeInTheDocument();
    expect(screen.getByText('draft failed')).toBeInTheDocument();
  });

  it('invokes onRetry when the Retry button is clicked', () => {
    const onRetry = vi.fn();
    render(
      <AnswerCard
        question={questions[0]}
        answer={{ ...answers.answers[0], answer: '' }}
        resume={resume}
        status="error"
        onChangeText={vi.fn()}
        onRegenerate={vi.fn()}
        onCopy={vi.fn()}
        onSelectGrounding={vi.fn()}
        onRetry={onRetry}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('does not render a Retry button when onRetry is omitted', () => {
    render(
      <AnswerCard
        question={questions[0]}
        answer={{ ...answers.answers[0], answer: '' }}
        resume={resume}
        status="error"
        onChangeText={vi.fn()}
        onRegenerate={vi.fn()}
        onCopy={vi.fn()}
        onSelectGrounding={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });
});
