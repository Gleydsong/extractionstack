const MASTER_KEY_BYTES = 32;
const MASTER_KEY_BASE64_LENGTH = 44;
const CANONICAL_MASTER_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function decodeCanonicalCredentialMasterKey(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || value.length !== MASTER_KEY_BASE64_LENGTH) {
    return undefined;
  }
  if (!CANONICAL_MASTER_KEY_PATTERN.test(value)) {
    return undefined;
  }

  const finalDataIndex = BASE64_ALPHABET.indexOf(value.at(-2) ?? '');
  if (finalDataIndex < 0 || finalDataIndex % 4 !== 0) {
    return undefined;
  }

  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== MASTER_KEY_BYTES || decoded.toString('base64') !== value) {
    decoded.fill(0);
    return undefined;
  }

  return decoded;
}

export function isCanonicalCredentialMasterKey(value: unknown): value is string {
  const decoded = decodeCanonicalCredentialMasterKey(value);
  if (!decoded) return false;

  decoded.fill(0);
  return true;
}
