import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

const repositoryRoot = resolve(process.cwd(), '../..');

function repositoryFile(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), 'utf8');
}

describe('worker runtime dependencies', () => {
  it('declares ipaddr.js used by the bundled URL safety code', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as PackageManifest;

    expect(manifest.dependencies?.['ipaddr.js']).toBeDefined();
  });

  it('ships the dedicated LLM worker with a deterministic local provider', () => {
    const compose = repositoryFile('docker-compose.yml');
    const dockerfile = repositoryFile('Dockerfile');

    expect(dockerfile).toContain('FROM workspace AS llm-worker');
    expect(dockerfile).toContain('@extractionstack/llm-worker');
    expect(dockerfile).toMatch(/USER node/);
    expect(compose).toMatch(/^ {2}llm-worker:\n/m);
    expect(compose).toContain("LLM_PROVIDER_MODE: 'fake'");
    expect(compose).not.toMatch(/LLM_PLATFORM_(OPENAI|GEMINI)_API_KEY/);
  });

  it('keeps ordinary CI provider-double-only and runs the full gate', () => {
    const ci = repositoryFile('.github/workflows/ci.yml');
    const manifest = JSON.parse(repositoryFile('package.json')) as PackageManifest;

    expect(ci).toContain('pnpm verify');
    expect(ci).toContain('pnpm test:e2e');
    expect(ci).toContain('TEST_DATABASE_URL:');
    expect(ci).toContain('TEST_REDIS_URL:');
    expect(ci).not.toMatch(/LLM_PLATFORM_(OPENAI|GEMINI)_API_KEY/);
    expect(manifest.scripts?.['test:smoke:providers']).toContain('RUN_REAL_PROVIDER_SMOKE');
    expect(ci).not.toContain('test:smoke:providers');
  });
});
