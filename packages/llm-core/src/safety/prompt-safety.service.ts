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

const SENSITIVE_HEADER =
  /(^|\n)(\s*(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)\s*:)\s*[^\r\n]*/gi;
const SECRET_LIKE_VALUE =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)\s*=\s*([^\s&#;,]+)/gi;
const SOURCE_DELIMITER = /<\/?untrusted_extraction_report\s*>/gi;
const INSTRUCTION_LIKE_CONTENT =
  /\b(?:ignore|disregard|override|forget)\b[^\n.]{0,100}\b(?:instructions?|prompt|policy|rules?)\b|\b(?:system|developer)\s+prompt\b|\bfollow\s+(?:these|my|system)\s+(?:instructions?|prompt)\b/i;

export class PromptSafetyService {
  inspect(input: string): SafetyInspection {
    const reasons: SafetyReasonCode[] = [];
    let safeText = input;

    safeText = safeText.replace(SENSITIVE_HEADER, (_match, prefix: string, header: string) => {
      addReason(reasons, 'SENSITIVE_HEADER_VALUE');
      return `${prefix}${header} [REDACTED]`;
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

    const frozenReasons = Object.freeze([...reasons]);
    return Object.freeze({
      safeText,
      reasonCodes: frozenReasons,
      modified: safeText !== input,
    });
  }
}

function addReason(reasons: SafetyReasonCode[], reason: SafetyReasonCode): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}
