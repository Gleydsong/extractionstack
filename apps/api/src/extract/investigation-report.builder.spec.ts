import type { CrawledPage, DetectorResult } from '@extractionstack/shared';
import { describe, expect, it } from 'vitest';
import { buildInvestigationReport } from './investigation-report.builder.js';

const page: CrawledPage = {
  finalUrl: 'https://example.com/',
  status: 200,
  html: '<!doctype html><html><head><title>Example</title></head><body><h1>Example</h1><img src="hero.webp"><script src="/assets/app.js"></script></body></html>',
  headers: {
    server: 'nginx',
    'content-security-policy': "default-src 'self'",
    'set-cookie': 'session=private-value',
    'x-client-ip': '203.0.113.42',
  },
  responseHeaders: {},
  networkLog: [
    {
      url: 'https://api.example.com/public/items?token=secret',
      method: 'GET',
      resourceType: 'fetch',
      status: 200,
    },
  ],
  cookies: [
    { name: 'session', value: 'private-value', secure: true, httpOnly: true, sameSite: 'Lax' },
  ],
  meta: { title: 'Example' },
  scripts: [{ src: 'https://example.com/assets/app.js' }],
  stylesheets: [{ href: 'https://example.com/assets/app.css' }],
  linkRel: [],
  computedStyles: [],
  fetchedAt: '2026-07-16T00:00:00.000Z',
};

const detectors: DetectorResult[] = [
  {
    dimension: 'backendFramework',
    status: 'ok',
    data: { detected: ['nginx'], primary: 'nginx' },
    evidence: [{ source: 'header', snippet: 'Server: nginx', confidence: 'high' }],
  },
  {
    dimension: 'architecture',
    status: 'ok',
    data: { rendering: 'unknown', apiStyle: 'rest' },
    evidence: [{ source: 'network', snippet: '1 REST-like call', confidence: 'medium' }],
  },
];

describe('buildInvestigationReport', () => {
  it('produces every mandatory report section and confidence matrix row', () => {
    const report = buildInvestigationReport(page, detectors, 'https://example.com');
    expect(Object.keys(report.sections)).toEqual([
      'frontend',
      'designSystem',
      'backend',
      'apisCommunication',
      'authenticationSecurity',
      'cmsContent',
      'infrastructureDeploy',
      'integrations',
      'performanceAccessibility',
    ]);
    expect(report.confidenceMatrix).toHaveLength(14);
    expect(report.diagramMermaid).toContain('flowchart TD');
    expect(report.technicalEvidence.publicEndpoints).toEqual([
      'GET https://api.example.com/public/items',
    ]);
  });

  it('does not invent CMS and never exports cookie/header secrets', () => {
    const report = buildInvestigationReport(page, detectors, 'https://example.com');
    const serialized = JSON.stringify(report);
    expect(report.sections.cmsContent.findings[0]).toMatchObject({
      confidence: 'not_identified',
    });
    expect(serialized).not.toContain('private-value');
    expect(serialized).not.toContain('token=secret');
    expect(serialized).not.toContain('203.0.113.42');
    expect(report.technicalEvidence.relevantHeaders).not.toHaveProperty('x-client-ip');
  });

  it('does not aggregate unrelated weak signatures into high confidence technologies', () => {
    const report = buildInvestigationReport(
      page,
      [
        ...detectors,
        {
          dimension: 'cssFramework',
          status: 'ok',
          data: { detected: ['bootstrap', 'bulma'], primary: 'bootstrap' },
          evidence: [
            { source: 'html', snippet: 'bootstrap class signature', confidence: 'medium' },
            { source: 'html', snippet: 'bulma class signature', confidence: 'medium' },
          ],
        },
      ],
      'https://example.com',
    );

    expect(
      report.technologyTable
        .filter((finding) => ['bootstrap', 'bulma'].includes(finding.name))
        .map((finding) => ({ name: finding.name, confidence: finding.confidence })),
    ).toEqual([
      { name: 'bootstrap', confidence: 'probable' },
      { name: 'bulma', confidence: 'probable' },
    ]);
    expect(
      report.confidenceMatrix.find((row) => row.information === 'Framework CSS')?.confidence,
    ).toBe('probable');
  });

  it('classifies negative detector evidence as not identified', () => {
    const report = buildInvestigationReport(
      page,
      [
        ...detectors,
        {
          dimension: 'databaseIndicators',
          status: 'ok',
          data: { detected: [], indicators: [] },
          evidence: [
            { source: 'html', snippet: 'no database signature found', confidence: 'medium' },
          ],
        },
      ],
      'https://example.com',
    );

    expect(
      report.confidenceMatrix.find((row) => row.information === 'Banco de dados'),
    ).toMatchObject({ result: 'Não identificado', confidence: 'not_identified' });
  });

  it('reports confirmed passive accessibility problems and recommendations', () => {
    const report = buildInvestigationReport(page, detectors, 'https://example.com');
    expect(report.risks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Imagens sem atributo alt', status: 'confirmed_problem' }),
        expect.objectContaining({
          title: 'Idioma do documento ausente',
          status: 'confirmed_problem',
        }),
      ]),
    );
    expect(report.recommendations.length).toBeGreaterThan(0);
  });
});
