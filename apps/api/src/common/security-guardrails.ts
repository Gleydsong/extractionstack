export interface SourceFile {
  path: string;
  content: string;
}

const UNSAFE_PRISMA_APIS = /\$(?:queryRawUnsafe|executeRawUnsafe)\s*\(/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{9,63}$/;

export function findUnsafeRawQueries(files: readonly SourceFile[]): string[] {
  return files.flatMap((file) =>
    UNSAFE_PRISMA_APIS.test(file.content) ? [file.path] : [],
  );
}

export function assertSafeIdentifier(value: string): string {
  if (!SAFE_IDENTIFIER.test(value)) throw new Error('invalid identifier');
  return value;
}
