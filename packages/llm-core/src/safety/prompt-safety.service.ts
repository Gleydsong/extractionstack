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
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
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
const QUOTED_SENSITIVE_HEADER =
  /(['"])((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)\s*:)[^\r\n]*?\1/gi;
const EMBEDDED_SENSITIVE_HEADER =
  /((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)\s*:)(?!\s*\[REDACTED\])\s*[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/gi;
const SECRET_LIKE_VALUE =
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|auth)\s*(?:=|:)\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&#;,]+)/gi;
const SOURCE_DELIMITER = /<\/?untrusted_extraction_report\s*>/gi;
const INSTRUCTION_LIKE_CONTENT =
  /\b(?:ignore|disregard|override|forget)\b[^\n.]{0,100}\b(?:instructions?|prompt|policy|rules?)\b|\b(?:system|developer)\s+prompt\b|\bfollow\s+(?:these|my|system)\s+(?:instructions?|prompt)\b/i;

export class PromptSafetyService {
  inspect(input: string): SafetyInspection {
    const reasons: SafetyReasonCode[] = [];
    let safeText = normalizeLineEndings(input);

    safeText = safeText.replace(
      QUOTED_SENSITIVE_HEADER,
      (_match, quote: string, header: string) => {
        addReason(reasons, 'SENSITIVE_HEADER_VALUE');
        return `${quote}${header} [REDACTED]${quote}`;
      },
    );
    safeText = safeText.replace(EMBEDDED_SENSITIVE_HEADER, (_match, header: string) => {
      addReason(reasons, 'SENSITIVE_HEADER_VALUE');
      return `${header} [REDACTED]`;
    });
    safeText = safeText.replace(SECRET_LIKE_VALUE, () => {
      addReason(reasons, 'SECRET_LIKE_VALUE');
      return '[SECRET VALUE REDACTED]';
    });
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
    const reasons: SafetyReasonCode[] = [];
    const normalizedInput = normalizeSingleLine(input);
    const parsed = parseUrl(normalizedInput);
    if (!parsed) return this.inspect(decodeConservatively(normalizedInput));

    if (parsed.url.username || parsed.url.password) {
      parsed.url.username = '';
      parsed.url.password = '';
      addReason(reasons, 'SECRET_LIKE_VALUE');
    }

    const safeQuery = new URLSearchParams();
    for (const [key, value] of parsed.url.searchParams.entries()) {
      if (isSecretKey(key)) {
        addReason(reasons, 'SECRET_LIKE_VALUE');
      } else {
        safeQuery.append(key, value);
      }
    }
    parsed.url.search = safeQuery.toString();

    const safeText = parsed.relative
      ? `${parsed.url.pathname}${parsed.url.search}${parsed.url.hash}`
      : parsed.url.toString();
    return inspection(safeText, reasons, safeText !== input);
  }

  inspectHeader(name: string, value: string): SafetyInspection {
    const normalizedName = normalizeSingleLine(name);
    const safeName =
      normalizedName.length <= 160 ? normalizedName : '[HEADER NAME OMITTED BY SAFE LIMIT]';
    if (isSensitiveHeaderName(normalizedName)) {
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

function isSecretKey(key: string): boolean {
  return SECRET_QUERY_KEYS.has(
    key
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ''),
  );
}

function isSensitiveHeaderName(name: string): boolean {
  return name
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .some((part) => SENSITIVE_HEADER_NAMES.has(part));
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

function parseUrl(value: string): { url: URL; relative: boolean } | undefined {
  try {
    return { url: new URL(value), relative: false };
  } catch {
    try {
      const url = new URL(value, 'https://sanitizer.invalid');
      return { url, relative: true };
    } catch {
      return undefined;
    }
  }
}
