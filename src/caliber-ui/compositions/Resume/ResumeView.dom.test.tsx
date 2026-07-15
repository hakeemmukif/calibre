// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { describe, expect, it, afterEach } from 'vitest';
import { ResumeView } from './ResumeView';
import { resume } from '../../fixtures';
import { Resume } from '../../../types';

// T5b-2: vision-extracted résumés can hallucinate (a model invented a
// project in an earlier bake-off) — the review-nudge banner is the
// human-verification guardrail, shown only when extractionPath is "vision".
describe('ResumeView review-nudge banner', () => {
  afterEach(cleanup);

  it('shows the banner when extractionPath is "vision"', () => {
    const visionResume = Resume.parse({ ...resume, extractionPath: 'vision' });
    render(<ResumeView resume={visionResume} onReupload={() => {}} />);
    expect(screen.getByText(/we read this résumé from an image/i)).toBeInTheDocument();
  });

  it('hides the banner when extractionPath is "text"', () => {
    const textResume = Resume.parse({ ...resume, extractionPath: 'text' });
    render(<ResumeView resume={textResume} onReupload={() => {}} />);
    expect(screen.queryByText(/we read this résumé from an image/i)).not.toBeInTheDocument();
  });

  it('hides the banner when extractionPath is absent', () => {
    render(<ResumeView resume={resume} onReupload={() => {}} />);
    expect(screen.queryByText(/we read this résumé from an image/i)).not.toBeInTheDocument();
  });
});
