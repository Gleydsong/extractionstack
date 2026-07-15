import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSafeIdentifier, findUnsafeRawQueries } from './security-guardrails.js';

function productionTypeScriptFiles(directory: string): Array<{ path: string; content: string }> {
  return readdirSync(directory).flatMap((name) => {
    const absolute = path.join(directory, name);
    if (statSync(absolute).isDirectory()) return productionTypeScriptFiles(absolute);
    if (!name.endsWith('.ts') || name.endsWith('.spec.ts')) return [];
    return [{ path: absolute, content: readFileSync(absolute, 'utf8') }];
  });
}

describe('security guardrails', () => {
  it('contains no unsafe Prisma raw query APIs in production sources', () => {
    const sourceRoot = path.resolve(__dirname, '..');
    expect(findUnsafeRawQueries(productionTypeScriptFiles(sourceRoot))).toEqual([]);
  });

  it.each(["' OR 1=1 --", "x'; DROP TABLE User; --", '${7*7}', '__proto__', 'a/b']) (
    'rejects an unsafe identifier: %s',
    (value) => {
      expect(() => assertSafeIdentifier(value)).toThrow();
    },
  );

  it('accepts a bounded application identifier', () => {
    expect(assertSafeIdentifier('cm1234567890abcdef')).toBe('cm1234567890abcdef');
  });
});
