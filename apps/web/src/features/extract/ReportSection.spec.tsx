import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DetectorResult } from '@extractionstack/shared';
import { ReportSection } from './ReportSection';

describe('ReportSection', () => {
  it.each([
    [
      { dimension: 'seo', status: 'skipped', reason: 'no metadata' },
      'no metadata',
    ],
    [
      { dimension: 'seo', status: 'error', error: 'detector failed' },
      'detector failed',
    ],
  ] satisfies [DetectorResult, string][])('renders a non-ok result %#', (section, expected) => {
    render(<ReportSection section={section} isOpen onToggle={vi.fn()} />);

    expect(screen.getByText(new RegExp(expected))).toBeInTheDocument();
  });

  it('renders evidence without interpreting the snippet as markup', () => {
    render(
      <ReportSection
        section={{
          dimension: 'seo',
          status: 'ok',
          data: { title: 'Example' },
          evidence: [
            {
              source: 'html',
              snippet: '<img src=x onerror=alert(1)>',
              confidence: 'high',
            },
          ],
        }}
        isOpen
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });
});
