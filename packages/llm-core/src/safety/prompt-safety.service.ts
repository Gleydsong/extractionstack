export const SAFETY_REASON_CODES = [
  'SENSITIVE_HEADER_VALUE',
  'SECRET_LIKE_VALUE',
  'SOURCE_DELIMITER_ESCAPE',
  'INSTRUCTION_LIKE_CONTENT',
] as const;

export type SafetyReasonCode = (typeof SAFETY_REASON_CODES)[number];

export type SafetyInspection = Readonly<{
  safeText: string;
  reasonCodes: readonly SafetyReasonCode[];
  modified: boolean;
}>;

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'xapikey',
  'xauthtoken',
]);
const SECRET_QUERY_KEYS = new Set([
  'apikey',
  'token',
  'accesstoken',
  'refreshtoken',
  'password',
  'passwd',
  'clientsecret',
  'secret',
  'auth',
  'authorization',
]);
const SECRET_ASSIGNMENT_START =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|authorization)\b\s*(?:=|:)\s*/gi;
const QUOTED_SENSITIVE_HEADER_START =
  /(['"])((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)\s*:)\s*/gi;
const EMBEDDED_SENSITIVE_HEADER =
  /((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)\s*:)(?!\s*\[REDACTED\])\s*[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/gi;
const SOURCE_DELIMITER = /<\/?untrusted_(?:extraction_report|source_prompt)(?:\s+[^>]*)?\s*>/gi;
const INSTRUCTION_LIKE_CONTENT =
  /\b(?:ignore|disregard|override|forget)\b[^\n.]{0,100}\b(?:instructions?|prompt|policy|rules?)\b|\b(?:system|developer)\s+prompt\b|\bfollow\s+(?:these|my|system)\s+(?:instructions?|prompt)\b/i;
const ABSOLUTE_HTTP_URL = /^https?:\/\//i;
const EXPLICIT_RELATIVE_REFERENCE = /^(?:\/|\.\/|\.\.\/|\?|#)/;
const SECRET_MARKER = '[SECRET VALUE REDACTED]';
const MAX_SAFE_URL_CHARS = 4_096;
const MAX_SECRET_VALUE_SCAN_CHARS = 8_192;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

type ParsedAssignmentValue = Readonly<{
  end: number;
  credentialText: string;
  closed: boolean;
}>;

export class PromptSafetyService {
  inspect(input: string): SafetyInspection {
    const reasons: SafetyReasonCode[] = [];
    let safeText = normalizeLineEndings(input);

    const quotedHeaders = redactQuotedSensitiveHeaders(safeText);
    safeText = quotedHeaders.safeText;
    if (quotedHeaders.modified) addReason(reasons, 'SENSITIVE_HEADER_VALUE');
    safeText = safeText.replace(EMBEDDED_SENSITIVE_HEADER, (_match, header: string) => {
      addReason(reasons, 'SENSITIVE_HEADER_VALUE');
      return `${header} [REDACTED]`;
    });

    const assignmentInspection = redactSecretAssignments(safeText);
    safeText = assignmentInspection.safeText;
    if (assignmentInspection.modified) addReason(reasons, 'SECRET_LIKE_VALUE');

    safeText = safeText.replace(SOURCE_DELIMITER, () => {
      addReason(reasons, 'SOURCE_DELIMITER_ESCAPE');
      return '[DELIMITADOR DE FONTE REMOVIDO]';
    });
    if (INSTRUCTION_LIKE_CONTENT.test(safeText)) {
      addReason(reasons, 'INSTRUCTION_LIKE_CONTENT');
    }

    return inspection(safeText, reasons, safeText !== input);
  }

  inspectUrl(input: string): SafetyInspection {
    const normalizedInput = normalizeSingleLine(input);
    if (ABSOLUTE_HTTP_URL.test(normalizedInput)) {
      return this.inspectAbsoluteUrl(normalizedInput, input);
    }
    if (EXPLICIT_RELATIVE_REFERENCE.test(normalizedInput)) {
      return this.inspectRelativeUrl(normalizedInput, input);
    }
    return this.inspect(decodeConservatively(normalizedInput));
  }

  inspectHeader(name: string, value: string): SafetyInspection {
    const normalizedName = normalizeSingleLine(name);
    const canonicalName = canonicalizeHeaderName(name);
    const safeName =
      normalizedName.length <= 160 ? normalizedName : '[HEADER NAME OMITTED BY SAFE LIMIT]';
    const ambiguousFoldedName = hasControlOrFolding(name);
    if (SENSITIVE_HEADER_NAMES.has(canonicalName) || ambiguousFoldedName) {
      return inspection(`${safeName}: [REDACTED]`, ['SENSITIVE_HEADER_VALUE'], true);
    }

    const normalizedValue = normalizeSingleLine(value);
    const valueInspection =
      normalizedValue.length <= 4_000
        ? this.inspect(normalizedValue)
        : inspection('[HEADER VALUE OMITTED BY SAFE LIMIT]', [], true);
    return inspection(
      `${safeName}: ${valueInspection.safeText}`,
      [...valueInspection.reasonCodes],
      safeName !== name || normalizedValue !== value || valueInspection.modified,
    );
  }

  private inspectAbsoluteUrl(normalizedInput: string, originalInput: string): SafetyInspection {
    let url: URL;
    try {
      url = new URL(normalizedInput);
    } catch {
      return this.inspect(decodeConservatively(normalizedInput));
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return this.inspect(decodeConservatively(normalizedInput));
    }

    const reasons: SafetyReasonCode[] = [];
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
      addReason(reasons, 'SECRET_LIKE_VALUE');
    }
    url.pathname = sanitizePath(url.pathname, reasons, this);
    url.search = sanitizeParameters(url.searchParams, reasons, this);
    url.hash = sanitizeFragment(url.hash, reasons, this);
    return finalizeUrl(url.toString(), reasons, originalInput);
  }

  private inspectRelativeUrl(normalizedInput: string, originalInput: string): SafetyInspection {
    if (normalizedInput.startsWith('//')) {
      try {
        const parsed = new URL(`https:${normalizedInput}`);
        const inspected = this.inspectAbsoluteUrl(parsed.toString(), originalInput);
        const safeText = inspected.safeText.startsWith('https:')
          ? inspected.safeText.slice('https:'.length)
          : inspected.safeText;
        return inspection(safeText, inspected.reasonCodes, safeText !== originalInput);
      } catch {
        return this.inspect(decodeConservatively(normalizedInput));
      }
    }

    const reasons: SafetyReasonCode[] = [];
    const reference = splitRelativeReference(normalizedInput);
    const safePath = sanitizePath(reference.path, reasons, this);
    const safeQuery = sanitizeParameters(new URLSearchParams(reference.query), reasons, this);
    const safeFragment = sanitizeFragment(
      reference.fragment ? `#${reference.fragment}` : '',
      reasons,
      this,
    );
    const queryPrefix = safeQuery ? `?${safeQuery}` : '';
    return finalizeUrl(`${safePath}${queryPrefix}${safeFragment}`, reasons, originalInput);
  }
}

function redactSecretAssignments(input: string): { safeText: string; modified: boolean } {
  const matcher = new RegExp(SECRET_ASSIGNMENT_START.source, SECRET_ASSIGNMENT_START.flags);
  const parts: string[] = [];
  let cursor = 0;
  let modified = false;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(input)) !== null) {
    const canonicalKey = canonicalizeKey(match[1] ?? '');
    const value = parseAssignmentValue(input, matcher.lastIndex, canonicalKey === 'authorization');
    if (!value) continue;
    if (canonicalKey === 'authorization' && !isCredentialShaped(value.credentialText)) {
      matcher.lastIndex = value.end;
      continue;
    }

    parts.push(input.slice(cursor, match.index), SECRET_MARKER);
    cursor = value.end;
    matcher.lastIndex = value.end;
    modified = true;
  }

  if (!modified) return { safeText: input, modified: false };
  parts.push(input.slice(cursor));
  return { safeText: parts.join(''), modified: true };
}

function redactQuotedSensitiveHeaders(input: string): { safeText: string; modified: boolean } {
  const matcher = new RegExp(
    QUOTED_SENSITIVE_HEADER_START.source,
    QUOTED_SENSITIVE_HEADER_START.flags,
  );
  const parts: string[] = [];
  let cursor = 0;
  let modified = false;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(input)) !== null) {
    const quoteStart = match.index;
    const value = scanQuotedValue(input, quoteStart);
    const quote = match[1] ?? '';
    const header = match[2] ?? '';
    parts.push(
      input.slice(cursor, quoteStart),
      `${quote}${header} [REDACTED]${value.closed ? quote : ''}`,
    );
    cursor = value.end;
    matcher.lastIndex = value.end;
    modified = true;
  }

  if (!modified) return { safeText: input, modified: false };
  parts.push(input.slice(cursor));
  return { safeText: parts.join(''), modified: true };
}

function parseAssignmentValue(
  input: string,
  start: number,
  authorization: boolean,
): ParsedAssignmentValue | undefined {
  if (start >= input.length) return undefined;
  const first = input[start];
  if (first !== '"' && first !== "'") {
    let end = start;
    while (end < input.length && !/\s/.test(input[end] ?? '')) end += 1;
    const firstToken = input.slice(start, end);
    if (authorization && /^(?:bearer|basic)$/i.test(firstToken)) {
      let credentialStart = end;
      while (credentialStart < input.length && /[ \t]/.test(input[credentialStart] ?? '')) {
        credentialStart += 1;
      }
      let credentialEnd = credentialStart;
      while (credentialEnd < input.length && !/\s/.test(input[credentialEnd] ?? '')) {
        credentialEnd += 1;
      }
      if (credentialEnd > credentialStart) {
        return {
          end: credentialEnd,
          credentialText: `${firstToken} ${input.slice(credentialStart, credentialEnd)}`,
          closed: true,
        };
      }
    }
    return end > start ? { end, credentialText: input.slice(start, end), closed: true } : undefined;
  }

  return scanQuotedValue(input, start);
}

function scanQuotedValue(input: string, start: number): ParsedAssignmentValue {
  const quote = input[start] ?? '';
  const lineEndIndex = input.indexOf('\n', start + 1);
  const lineEnd = lineEndIndex === -1 ? input.length : lineEndIndex;
  let escaped = false;
  const scanEnd = Math.min(lineEnd, start + 1 + MAX_SECRET_VALUE_SCAN_CHARS);
  for (let index = start + 1; index < scanEnd; index += 1) {
    const character = input[index];
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === quote) {
      return {
        end: index + 1,
        credentialText: unescapeQuoted(input.slice(start + 1, index)),
        closed: true,
      };
    }
  }
  return {
    end: lineEnd,
    credentialText: unescapeQuoted(input.slice(start + 1, lineEnd)),
    closed: false,
  };
}

function isCredentialShaped(value: string): boolean {
  const candidate = value.trim();
  return (
    /^(?:bearer|basic)\s+\S+/i.test(candidate) ||
    /^(?:sk|pk|api|token)[-_][a-z0-9._-]{6,}$/i.test(candidate) ||
    /^[a-z0-9+/_=-]{20,}$/i.test(candidate)
  );
}

function unescapeQuoted(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}

function sanitizePath(
  path: string,
  reasons: SafetyReasonCode[],
  safety: PromptSafetyService,
): string {
  return path
    .split('/')
    .map((segment) => {
      if (!segment || segment === '.' || segment === '..') return segment;
      const decoded = decodeConservatively(segment);
      const inspected = safety.inspect(decoded);
      mergeReasons(reasons, inspected.reasonCodes);
      return encodeURIComponent(inspected.safeText);
    })
    .join('/');
}

function sanitizeParameters(
  parameters: URLSearchParams,
  reasons: SafetyReasonCode[],
  safety: PromptSafetyService,
): string {
  const safeParameters = new URLSearchParams();
  for (const [key, value] of parameters.entries()) {
    if (isSecretKey(key)) {
      addReason(reasons, 'SECRET_LIKE_VALUE');
      continue;
    }
    const inspectedValue = safety.inspect(value);
    mergeReasons(reasons, inspectedValue.reasonCodes);
    safeParameters.append(key, inspectedValue.safeText);
  }
  return safeParameters.toString();
}

function sanitizeFragment(
  hash: string,
  reasons: SafetyReasonCode[],
  safety: PromptSafetyService,
): string {
  if (!hash) return '';
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw.includes('=') || raw.includes('&')) {
    const parameters = sanitizeParameters(new URLSearchParams(raw), reasons, safety);
    return parameters ? `#${parameters}` : '';
  }
  const inspected = safety.inspect(decodeConservatively(raw));
  mergeReasons(reasons, inspected.reasonCodes);
  return inspected.safeText ? `#${encodeURIComponent(inspected.safeText)}` : '';
}

function finalizeUrl(
  safeText: string,
  reasons: readonly SafetyReasonCode[],
  originalInput: string,
): SafetyInspection {
  const bounded = safeText.length <= MAX_SAFE_URL_CHARS ? safeText : '[URL OMITTED BY SAFE LIMIT]';
  return inspection(bounded, reasons, bounded !== originalInput);
}

function splitRelativeReference(value: string): {
  path: string;
  query: string;
  fragment: string;
} {
  const hashIndex = value.indexOf('#');
  const beforeHash = hashIndex === -1 ? value : value.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? '' : value.slice(hashIndex + 1);
  const queryIndex = beforeHash.indexOf('?');
  return {
    path: queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex),
    query: queryIndex === -1 ? '' : beforeHash.slice(queryIndex + 1),
    fragment,
  };
}

function inspection(
  safeText: string,
  reasonCodes: readonly SafetyReasonCode[],
  modified: boolean,
): SafetyInspection {
  return Object.freeze({
    safeText,
    reasonCodes: Object.freeze([...new Set(reasonCodes)]),
    modified,
  });
}

function addReason(reasons: SafetyReasonCode[], reason: SafetyReasonCode): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function mergeReasons(target: SafetyReasonCode[], source: readonly SafetyReasonCode[]): void {
  source.forEach((reason) => addReason(target, reason));
}

function canonicalizeKey(key: string): string {
  return key
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function isSecretKey(key: string): boolean {
  return SECRET_QUERY_KEYS.has(canonicalizeKey(key));
}

function canonicalizeHeaderName(name: string): string {
  return canonicalizeKey(name);
}

function hasControlOrFolding(value: string): boolean {
  return CONTROL_OR_FORMAT.test(value);
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function normalizeSingleLine(value: string): string {
  return normalizeLineEndings(value)
    .replace(/\n[ \t]*/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function decodeConservatively(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
