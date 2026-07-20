import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertSafeIdentifier,
  findDangerousProductionCode,
  findUnsafeRawQueries,
} from './security-guardrails.js';

function productionTypeScriptFiles(directory: string): Array<{ path: string; content: string }> {
  if (!existsSync(directory) || /(?:^|\/)(?:generated|dist|node_modules)(?:\/|$)/.test(directory))
    return [];
  return readdirSync(directory).flatMap((name) => {
    const absolute = path.join(directory, name);
    if (statSync(absolute).isDirectory()) return productionTypeScriptFiles(absolute);
    if (!/\.tsx?$/.test(name) || /\.(?:spec|test)\.tsx?$/.test(name)) return [];
    return [{ path: absolute, content: readFileSync(absolute, 'utf8') }];
  });
}

function productionSourceRoots(root: string): string[] {
  return ['apps', 'packages']
    .flatMap((group) => {
      const parent = path.join(root, group);
      if (!existsSync(parent)) return [];
      return readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(parent, entry.name, 'src'))
        .filter((source) => existsSync(source));
    })
    .sort();
}

describe('security guardrails', () => {
  it('discovers every current app and package production source root', () => {
    const root = path.resolve(__dirname, '../../../..');
    expect(productionSourceRoots(root).map((source) => path.relative(root, source))).toEqual([
      'apps/api/src',
      'apps/llm-worker/src',
      'apps/web/src',
      'apps/worker/src',
      'packages/llm-core/src',
      'packages/shared/src',
    ]);
  });

  it('contains no dangerous APIs across API, worker, and package production sources', () => {
    const root = path.resolve(__dirname, '../../../..');
    const files = productionSourceRoots(root).flatMap(productionTypeScriptFiles);
    expect(findUnsafeRawQueries(files)).toEqual([]);
    expect(findDangerousProductionCode(files)).toEqual([]);
  });

  it('rejects interpolated, concatenated, eval and child-process production code', () => {
    expect(
      findDangerousProductionCode([
        { path: 'unsafe.ts', content: 'prisma.$queryRaw(`SELECT * FROM User WHERE id = ${id}`)' },
        { path: 'concat.ts', content: 'prisma.$executeRaw("DELETE FROM User WHERE id=" + id)' },
        { path: 'eval.ts', content: 'eval(input)' },
        { path: 'global-eval.ts', content: 'globalThis.eval(input)' },
        { path: 'window-eval.ts', content: 'window.eval(input)' },
        { path: 'function.ts', content: 'const dynamic = new Function(input)' },
        { path: 'exec.ts', content: "import { exec } from 'node:child_process'" },
        { path: 'optional.ts', content: 'prisma?.$queryRawUnsafe?.(sql)' },
        { path: 'element.ts', content: "prisma['$executeRawUnsafe'](sql)" },
        { path: 'alias.ts', content: 'const query = prisma.$queryRaw; query(sql)' },
        {
          path: 'destructure.ts',
          content: 'const { $queryRawUnsafe: query } = prisma; query(sql)',
        },
        { path: 'prisma-raw.ts', content: "const raw = Prisma['raw']; raw(input)" },
        { path: 'bracket-eval.ts', content: "globalThis['eval'](input)" },
        { path: 'eval-alias.ts', content: 'const execute = eval; execute(input)' },
        { path: 'require.ts', content: "const cp = require('child_process')" },
        { path: 'computed-unsafe.ts', content: "prisma['$queryRaw' + 'Unsafe']?.(sql)" },
        { path: 'raw-destructure.ts', content: 'const { raw: renamed } = Prisma; renamed(input)' },
        { path: 'raw-alias.ts', content: "const P = Prisma; const { ['r' + 'aw']: renamed } = P" },
        { path: 'global-function.ts', content: "new globalThis['Function'](input)" },
        {
          path: 'function-chain.ts',
          content: 'const Dynamic = window.Function; const Later = Dynamic; Later(input)',
        },
        { path: 'require-concat.ts', content: "require('node:' + 'child_' + 'process')" },
        { path: 'import-template.ts', content: "import(`node:${'child_' + 'process'}`)" },
      ]),
    ).toEqual([
      'unsafe.ts',
      'concat.ts',
      'eval.ts',
      'global-eval.ts',
      'window-eval.ts',
      'function.ts',
      'exec.ts',
      'optional.ts',
      'element.ts',
      'alias.ts',
      'destructure.ts',
      'prisma-raw.ts',
      'bracket-eval.ts',
      'eval-alias.ts',
      'require.ts',
      'computed-unsafe.ts',
      'raw-destructure.ts',
      'raw-alias.ts',
      'global-function.ts',
      'function-chain.ts',
      'require-concat.ts',
      'import-template.ts',
    ]);
  });

  it('allows parameterized Prisma tagged templates', () => {
    expect(
      findDangerousProductionCode([
        { path: 'safe.ts', content: 'prisma.$queryRaw`SELECT * FROM "User" WHERE "id" = ${id}`' },
        { path: 'safe-computed.ts', content: "prisma['$query' + 'Raw']`SELECT 1`" },
      ]),
    ).toEqual([]);
  });

  it('allows Redis member eval and its typed interface signature', () => {
    expect(
      findDangerousProductionCode([
        { path: 'redis.ts', content: "await redis.eval('return 1', 0)" },
        {
          path: 'redis-port.ts',
          content: 'interface RedisPort { eval(script: string, keys: number): Promise<unknown>; }',
        },
        { path: 'redis-bracket.ts', content: "await redis['eval']('return 1', 0)" },
        { path: 'redis-computed.ts', content: "await redis['e' + 'val']('return 1', 0)" },
      ]),
    ).toEqual([]);
  });

  it.each(["' OR 1=1 --", "x'; DROP TABLE User; --", '${7*7}', '__proto__', 'a/b'])(
    'rejects an unsafe identifier: %s',
    (value) => {
      expect(() => assertSafeIdentifier(value)).toThrow();
    },
  );

  it('accepts a bounded application identifier', () => {
    expect(assertSafeIdentifier('cm1234567890abcdef')).toBe('cm1234567890abcdef');
  });
});
