import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  dependencies?: Record<string, string>;
}

describe('worker runtime dependencies', () => {
  it('declares ipaddr.js used by the bundled URL safety code', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as PackageManifest;

    expect(manifest.dependencies?.['ipaddr.js']).toBeDefined();
  });
});
