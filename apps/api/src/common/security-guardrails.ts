import ts from 'typescript';

export interface SourceFile {
  path: string;
  content: string;
}
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{9,63}$/;
const UNSAFE_RAW = new Set(['$queryRawUnsafe', '$executeRawUnsafe']);
const RAW_CALL = new Set(['$queryRaw', '$executeRaw']);
const CHILD_PROCESS = new Set(['child_process', 'node:child_process']);
type Finding =
  | 'unsafe-raw'
  | 'raw-call'
  | 'prisma-raw'
  | 'eval'
  | 'dynamic-function'
  | 'child-process'
  | 'syntax';

export function findUnsafeRawQueries(files: readonly SourceFile[]): string[] {
  return files.flatMap((file) => (analyze(file).has('unsafe-raw') ? [file.path] : []));
}
export function findDangerousProductionCode(files: readonly SourceFile[]): string[] {
  return files.flatMap((file) => (analyze(file).size > 0 ? [file.path] : []));
}
export function assertSafeIdentifier(value: string): string {
  if (!SAFE_IDENTIFIER.test(value)) throw new Error('invalid identifier');
  return value;
}

function analyze(input: SourceFile): ReadonlySet<Finding> {
  const source = ts.createSourceFile(
    input.path,
    input.content,
    ts.ScriptTarget.Latest,
    true,
    input.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings = new Set<Finding>();
  const functionAliases = new Set(['Function']);
  const prismaAliases = new Set(['Prisma']);
  const parseDiagnostics = (
    source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  if (parseDiagnostics?.length) findings.add('syntax');

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      staticString(node.moduleSpecifier) &&
      CHILD_PROCESS.has(staticString(node.moduleSpecifier)!)
    )
      findings.add('child-process');
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      staticString(node.moduleReference.expression) &&
      CHILD_PROCESS.has(staticString(node.moduleReference.expression)!)
    )
      findings.add('child-process');
    if (ts.isVariableDeclaration(node))
      inspectVariable(node, findings, functionAliases, prismaAliases);
    if (ts.isBindingElement(node)) inspectBinding(node, findings, prismaAliases);
    if (ts.isIdentifier(node) && node.text === 'eval' && isStandaloneEvalReference(node))
      findings.add('eval');
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      inspectAccess(node, findings, prismaAliases);
    if (ts.isCallExpression(node)) inspectCall(node, findings, functionAliases, prismaAliases);
    if (ts.isNewExpression(node) && isDynamicFunction(node.expression, functionAliases))
      findings.add('dynamic-function');
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

function inspectVariable(
  node: ts.VariableDeclaration,
  findings: Set<Finding>,
  functionAliases: Set<string>,
  prismaAliases: Set<string>,
): void {
  const initializer = node.initializer;
  if (!initializer || !ts.isIdentifier(node.name)) return;
  if (isDynamicFunction(initializer, functionAliases)) {
    functionAliases.add(node.name.text);
    findings.add('dynamic-function');
  }
  if (ts.isIdentifier(initializer) && prismaAliases.has(initializer.text))
    prismaAliases.add(node.name.text);
}

function inspectBinding(
  node: ts.BindingElement,
  findings: Set<Finding>,
  prismaAliases: ReadonlySet<string>,
): void {
  const name = propertyName(node.propertyName ?? node.name);
  if (name && UNSAFE_RAW.has(name)) findings.add('unsafe-raw');
  if (name && RAW_CALL.has(name)) findings.add('raw-call');
  if (name === 'raw' && bindingSourceIsPrisma(node, prismaAliases)) findings.add('prisma-raw');
}

function bindingSourceIsPrisma(node: ts.BindingElement, aliases: ReadonlySet<string>): boolean {
  const pattern = node.parent;
  const declaration = pattern.parent;
  return (
    ts.isObjectBindingPattern(pattern) &&
    ts.isVariableDeclaration(declaration) &&
    Boolean(
      declaration.initializer &&
      ts.isIdentifier(declaration.initializer) &&
      aliases.has(declaration.initializer.text),
    )
  );
}

function inspectAccess(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  findings: Set<Finding>,
  prismaAliases: ReadonlySet<string>,
): void {
  const name = accessName(node);
  if (name && UNSAFE_RAW.has(name)) findings.add('unsafe-raw');
  if (
    name &&
    RAW_CALL.has(name) &&
    !(ts.isTaggedTemplateExpression(node.parent) && node.parent.tag === node)
  )
    findings.add('raw-call');
  if (name === 'raw' && ownerName(node) && prismaAliases.has(ownerName(node)!))
    findings.add('prisma-raw');
}

function inspectCall(
  node: ts.CallExpression,
  findings: Set<Finding>,
  functionAliases: ReadonlySet<string>,
  prismaAliases: ReadonlySet<string>,
): void {
  const expression = node.expression;
  if (ts.isIdentifier(expression)) {
    if (expression.text === 'eval') findings.add('eval');
    if (functionAliases.has(expression.text)) findings.add('dynamic-function');
    const module = firstStaticArgument(node);
    if (expression.text === 'require' && module && CHILD_PROCESS.has(module))
      findings.add('child-process');
    return;
  }
  const module = firstStaticArgument(node);
  if (expression.kind === ts.SyntaxKind.ImportKeyword && module && CHILD_PROCESS.has(module)) {
    findings.add('child-process');
    return;
  }
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression))
    return;
  const name = accessName(expression);
  const owner = ownerName(expression);
  if (name && UNSAFE_RAW.has(name)) findings.add('unsafe-raw');
  if (name && RAW_CALL.has(name)) findings.add('raw-call');
  if (name === 'raw' && owner && prismaAliases.has(owner)) findings.add('prisma-raw');
  if (name === 'eval' && (owner === 'globalThis' || owner === 'window')) findings.add('eval');
  if (name === 'Function' && (owner === 'globalThis' || owner === 'window'))
    findings.add('dynamic-function');
}

function isDynamicFunction(node: ts.Expression, aliases: ReadonlySet<string>): boolean {
  if (ts.isIdentifier(node)) return aliases.has(node.text);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const owner = ownerName(node);
    return accessName(node) === 'Function' && (owner === 'globalThis' || owner === 'window');
  }
  return false;
}

function isStandaloneEvalReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (
    (ts.isMethodSignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    parent.name === node
  )
    return false;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node)
  )
    return false;
  return true;
}

function accessName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null {
  return ts.isPropertyAccessExpression(node)
    ? node.name.text
    : staticString(node.argumentExpression);
}
function ownerName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null {
  return ts.isIdentifier(node.expression) ? node.expression.text : null;
}
function propertyName(node: ts.BindingName | ts.PropertyName | undefined): string | null {
  if (!node) return null;
  if (ts.isComputedPropertyName(node)) return staticString(node.expression);
  return ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)
    ? node.text
    : null;
}
function firstStaticArgument(node: ts.CallExpression): string | null {
  return staticString(node.arguments[0]);
}

function staticString(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = staticString(span.expression);
      if (expression === null) return null;
      value += expression + span.literal.text;
    }
    return value;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(node.left);
    const right = staticString(node.right);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isParenthesizedExpression(node)) return staticString(node.expression);
  return null;
}
