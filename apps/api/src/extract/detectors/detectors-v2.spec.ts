import { describe, it, expect } from 'vitest';
import { BackendFrameworkDetector } from './backend-framework.detector.js';
import { StateManagementDetector } from './state-management.detector.js';
import { CdnDetector } from './cdn.detector.js';
import { CloudProviderDetector } from './cloud-provider.detector.js';
import { DatabaseIndicatorsDetector } from './database-indicators.detector.js';
import { RoutingDetector } from './routing.detector.js';
import type { CrawledPage } from '@extractionstack/shared';

function page(overrides: Partial<CrawledPage> = {}): CrawledPage {
  return {
    finalUrl: 'https://example.com',
    status: 200,
    html: '',
    headers: {},
    responseHeaders: {},
    networkLog: [],
    cookies: [],
    meta: {},
    scripts: [],
    stylesheets: [],
    linkRel: [],
    computedStyles: [],
    perfTiming: {},
    fetchedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('BackendFrameworkDetector', () => {
  it('detects nginx via Server header', async () => {
    const r = await new BackendFrameworkDetector().detect(
      page({ headers: { server: 'nginx/1.25.0' } }),
    );
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.data.detected).toContain('nginx');
      expect(r.data.server).toBe('nginx/1.25.0');
      expect(r.evidence?.length).toBeGreaterThan(0);
    }
  });

  it('detects Express via X-Powered-By', async () => {
    const r = await new BackendFrameworkDetector().detect(
      page({ headers: { 'x-powered-by': 'Express' } }),
    );
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.data.detected).toContain('express');
      expect(r.data.language).toContain('JavaScript/TypeScript');
    }
  });

  it('detects Django via sessionid cookie', async () => {
    const r = await new BackendFrameworkDetector().detect(
      page({ cookies: [{ name: 'sessionid', value: 'abc', domain: 'example.com' }] }),
    );
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.data.detected).toContain('django');
      expect(r.data.language).toContain('Python');
    }
  });
});

describe('StateManagementDetector', () => {
  it('detects redux-toolkit in inline script', async () => {
    const r = await new StateManagementDetector().detect(
      page({
        scripts: [{ content: 'import { createSlice } from "@reduxjs/toolkit";' }],
      }),
    );
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.data.detected).toContain('redux-toolkit');
    }
  });
});

describe('CdnDetector', () => {
  it('detects fastly via x-fastly-request-id header', async () => {
    const r = await new CdnDetector().detect(
      page({
        headers: { 'x-fastly-request-id': 'abc123' },
        networkLog: [
          {
            url: 'https://x.fastly.net/asset.js',
            method: 'GET',
            resourceType: 'script',
            status: 200,
            responseHeaders: { 'x-fastly-request-id': 'abc123' },
          },
        ],
      }),
    );
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.data.detected).toContain('fastly');
    }
  });
});

describe('CloudProviderDetector', () => {
  it('detects AWS via x-amz-cf-id', async () => {
    const r = await new CloudProviderDetector().detect(
      page({
        networkLog: [
          {
            url: 'https://d111111abcdef8.cloudfront.net/x.js',
            method: 'GET',
            resourceType: 'script',
            status: 200,
            responseHeaders: { 'x-amz-cf-id': 'abc' },
          },
        ],
      }),
    );
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.data.detected).toContain('aws');
    }
  });

  it('detects Vercel via server header', async () => {
    const r = await new CloudProviderDetector().detect(
      page({ headers: { server: 'Vercel' } }),
    );
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.data.detected).toContain('vercel');
    }
  });
});

describe('DatabaseIndicatorsDetector', () => {
  it('detects Laravel via laravel_session cookie', async () => {
    const r = await new DatabaseIndicatorsDetector().detect(
      page({
        cookies: [
          { name: 'laravel_session', value: 'eyJ...', domain: 'example.com' },
          { name: 'XSRF-TOKEN', value: 'abc', domain: 'example.com' },
        ],
      }),
    );
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.data.detected).toContain('Laravel');
    }
  });

  it('detects NextAuth via next-auth.session-token', async () => {
    const r = await new DatabaseIndicatorsDetector().detect(
      page({
        cookies: [{ name: 'next-auth.session-token', value: 'jwt', domain: 'example.com' }],
      }),
    );
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.data.detected).toContain('NextAuth');
    }
  });
});

describe('RoutingDetector', () => {
  it('detects react-router in inline script', async () => {
    const r = await new RoutingDetector().detect(
      page({
        scripts: [{ content: 'import { createBrowserRouter } from "react-router-dom";' }],
      }),
    );
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.data.detected).toContain('react-router');
    }
  });

  it('detects next.js as file-based routing', async () => {
    const r = await new RoutingDetector().detect(
      page({ html: '<script>__NEXT_DATA__ = {}</script>' }),
    );
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.data.detected).toContain('next.js');
      expect(r.data.strategy).toBe('file-based');
    }
  });
});
