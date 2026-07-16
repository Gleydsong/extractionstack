import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { LlmProvider } from '@extractionstack/shared';
import { decodeCanonicalCredentialMasterKey } from '../common/credential-master-key.js';

const ALGORITHM = 'AES-256-GCM' as const;
const AES_256_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const ENVELOPE_KEYS = Object.freeze([
  'algorithm',
  'keyVersion',
  'wrappedKey',
  'wrappedKeyIv',
  'wrappedKeyTag',
  'ciphertext',
  'iv',
  'tag',
] as const);

export type CredentialEnvelope = Readonly<{
  algorithm: 'AES-256-GCM';
  keyVersion: string;
  wrappedKey: string;
  wrappedKeyIv: string;
  wrappedKeyTag: string;
  ciphertext: string;
  iv: string;
  tag: string;
}>;

export type SensitiveString = string & {
  readonly __sensitive: 'SensitiveString';
};

export type CredentialVaultErrorCode =
  | 'CREDENTIAL_VAULT_CONFIGURATION_INVALID'
  | 'CREDENTIAL_ENCRYPTION_FAILED'
  | 'CREDENTIAL_DECRYPTION_FAILED';

export class CredentialVaultError extends Error {
  readonly code: CredentialVaultErrorCode;

  constructor(code: CredentialVaultErrorCode) {
    super(code);
    this.name = 'CredentialVaultError';
    this.code = code;
  }
}

function decodeBase64(value: string, expectedBytes?: number): Buffer {
  if (!BASE64_PATTERN.test(value)) {
    throw new Error('invalid base64');
  }

  const decoded = Buffer.from(value, 'base64');
  if (
    decoded.toString('base64') !== value ||
    (expectedBytes !== undefined && decoded.length !== expectedBytes)
  ) {
    decoded.fill(0);
    throw new Error('invalid decoded length');
  }

  return decoded;
}

function isCanonicalBase64WithinDecodedBounds(
  value: unknown,
  minimumBytes: number,
  maximumBytes: number,
): value is string {
  if (typeof value !== 'string') return false;

  const maximumEncodedLength = Math.ceil(maximumBytes / 3) * 4;
  if (
    value.length < 4 ||
    value.length > maximumEncodedLength ||
    value.length % 4 !== 0 ||
    !BASE64_PATTERN.test(value)
  ) {
    return false;
  }

  const paddingBytes = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const decodedLength = (value.length / 4) * 3 - paddingBytes;
  if (decodedLength < minimumBytes || decodedLength > maximumBytes) return false;

  if (paddingBytes === 2) {
    const finalDataIndex = BASE64_ALPHABET.indexOf(value.at(-3) ?? '');
    if (finalDataIndex < 0 || finalDataIndex % 16 !== 0) return false;
  }
  if (paddingBytes === 1) {
    const finalDataIndex = BASE64_ALPHABET.indexOf(value.at(-2) ?? '');
    if (finalDataIndex < 0 || finalDataIndex % 4 !== 0) return false;
  }

  return true;
}

function assertValidEnvelope(value: unknown): asserts value is CredentialEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid envelope');
  }

  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== ENVELOPE_KEYS.length ||
    ownKeys.some((key) => typeof key !== 'string' || !ENVELOPE_KEYS.includes(key as never))
  ) {
    throw new Error('invalid envelope keys');
  }

  const envelope = value as Record<(typeof ENVELOPE_KEYS)[number], unknown>;
  if (
    envelope.algorithm !== ALGORITHM ||
    typeof envelope.keyVersion !== 'string' ||
    envelope.keyVersion.length < 1 ||
    envelope.keyVersion.length > 64 ||
    envelope.keyVersion.trim() !== envelope.keyVersion ||
    !isCanonicalBase64WithinDecodedBounds(
      envelope.wrappedKey,
      AES_256_KEY_BYTES,
      AES_256_KEY_BYTES,
    ) ||
    !isCanonicalBase64WithinDecodedBounds(envelope.wrappedKeyIv, GCM_IV_BYTES, GCM_IV_BYTES) ||
    !isCanonicalBase64WithinDecodedBounds(envelope.wrappedKeyTag, GCM_TAG_BYTES, GCM_TAG_BYTES) ||
    !isCanonicalBase64WithinDecodedBounds(envelope.ciphertext, 1, MAX_CREDENTIAL_BYTES) ||
    !isCanonicalBase64WithinDecodedBounds(envelope.iv, GCM_IV_BYTES, GCM_IV_BYTES) ||
    !isCanonicalBase64WithinDecodedBounds(envelope.tag, GCM_TAG_BYTES, GCM_TAG_BYTES)
  ) {
    throw new Error('invalid envelope shape');
  }
}

function encryptionMetadata(
  ownerId: string,
  provider: LlmProvider,
  keyVersion: string,
  purpose: 'credential' | 'data-key',
): Buffer {
  return Buffer.from(JSON.stringify({ keyVersion, ownerId, provider, purpose }), 'utf8');
}

function assertEncryptionContext(ownerId: string, provider: LlmProvider, keyVersion: string): void {
  if (
    ownerId.length < 1 ||
    ownerId.length > 256 ||
    !['FAKE', 'OPENAI', 'GEMINI'].includes(provider) ||
    keyVersion.length < 1 ||
    keyVersion.length > 64 ||
    keyVersion.trim() !== keyVersion
  ) {
    throw new Error('invalid encryption context');
  }
}

export class CredentialVault {
  readonly #masterKey: Buffer;
  readonly #keyVersion: string;

  constructor(masterKeyBase64: string, keyVersion: string) {
    try {
      assertEncryptionContext('configuration-check', 'FAKE', keyVersion);
      const masterKey = decodeCanonicalCredentialMasterKey(masterKeyBase64);
      if (!masterKey) throw new Error('invalid master key');

      this.#masterKey = masterKey;
      this.#keyVersion = keyVersion;
    } catch {
      throw new CredentialVaultError('CREDENTIAL_VAULT_CONFIGURATION_INVALID');
    }
  }

  async encrypt(
    ownerId: string,
    provider: LlmProvider,
    plaintext: string,
  ): Promise<CredentialEnvelope> {
    let dataKey: Buffer | undefined;
    let plaintextBuffer: Buffer | undefined;
    let credentialMetadata: Buffer | undefined;
    let keyMetadata: Buffer | undefined;
    let iv: Buffer | undefined;
    let wrappedKeyIv: Buffer | undefined;
    let ciphertext: Buffer | undefined;
    let tag: Buffer | undefined;
    let wrappedKey: Buffer | undefined;
    let wrappedKeyTag: Buffer | undefined;

    try {
      assertEncryptionContext(ownerId, provider, this.#keyVersion);
      plaintextBuffer = Buffer.from(plaintext, 'utf8');
      if (plaintextBuffer.length < 1 || plaintextBuffer.length > MAX_CREDENTIAL_BYTES) {
        throw new Error('invalid credential length');
      }

      dataKey = randomBytes(AES_256_KEY_BYTES);
      iv = randomBytes(GCM_IV_BYTES);
      wrappedKeyIv = randomBytes(GCM_IV_BYTES);
      credentialMetadata = encryptionMetadata(ownerId, provider, this.#keyVersion, 'credential');
      keyMetadata = encryptionMetadata(ownerId, provider, this.#keyVersion, 'data-key');

      const credentialCipher = createCipheriv('aes-256-gcm', dataKey, iv, {
        authTagLength: GCM_TAG_BYTES,
      });
      credentialCipher.setAAD(credentialMetadata);
      ciphertext = Buffer.concat([
        credentialCipher.update(plaintextBuffer),
        credentialCipher.final(),
      ]);
      tag = credentialCipher.getAuthTag();

      const keyCipher = createCipheriv('aes-256-gcm', this.#masterKey, wrappedKeyIv, {
        authTagLength: GCM_TAG_BYTES,
      });
      keyCipher.setAAD(keyMetadata);
      wrappedKey = Buffer.concat([keyCipher.update(dataKey), keyCipher.final()]);
      wrappedKeyTag = keyCipher.getAuthTag();

      return Object.freeze({
        algorithm: ALGORITHM,
        keyVersion: this.#keyVersion,
        wrappedKey: wrappedKey.toString('base64'),
        wrappedKeyIv: wrappedKeyIv.toString('base64'),
        wrappedKeyTag: wrappedKeyTag.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
      });
    } catch {
      throw new CredentialVaultError('CREDENTIAL_ENCRYPTION_FAILED');
    } finally {
      dataKey?.fill(0);
      plaintextBuffer?.fill(0);
      credentialMetadata?.fill(0);
      keyMetadata?.fill(0);
      iv?.fill(0);
      wrappedKeyIv?.fill(0);
      ciphertext?.fill(0);
      tag?.fill(0);
      wrappedKey?.fill(0);
      wrappedKeyTag?.fill(0);
    }
  }

  async decrypt(
    ownerId: string,
    provider: LlmProvider,
    envelope: CredentialEnvelope,
  ): Promise<SensitiveString> {
    let wrappedKey: Buffer | undefined;
    let wrappedKeyIv: Buffer | undefined;
    let wrappedKeyTag: Buffer | undefined;
    let ciphertext: Buffer | undefined;
    let iv: Buffer | undefined;
    let tag: Buffer | undefined;
    let dataKey: Buffer | undefined;
    let plaintextBuffer: Buffer | undefined;
    let credentialMetadata: Buffer | undefined;
    let keyMetadata: Buffer | undefined;

    try {
      assertValidEnvelope(envelope);
      assertEncryptionContext(ownerId, provider, envelope.keyVersion);
      if (envelope.algorithm !== ALGORITHM || envelope.keyVersion !== this.#keyVersion) {
        throw new Error('unsupported envelope');
      }

      wrappedKey = decodeBase64(envelope.wrappedKey, AES_256_KEY_BYTES);
      wrappedKeyIv = decodeBase64(envelope.wrappedKeyIv, GCM_IV_BYTES);
      wrappedKeyTag = decodeBase64(envelope.wrappedKeyTag, GCM_TAG_BYTES);
      ciphertext = decodeBase64(envelope.ciphertext);
      iv = decodeBase64(envelope.iv, GCM_IV_BYTES);
      tag = decodeBase64(envelope.tag, GCM_TAG_BYTES);
      if (ciphertext.length < 1 || ciphertext.length > MAX_CREDENTIAL_BYTES) {
        throw new Error('invalid ciphertext length');
      }

      credentialMetadata = encryptionMetadata(ownerId, provider, envelope.keyVersion, 'credential');
      keyMetadata = encryptionMetadata(ownerId, provider, envelope.keyVersion, 'data-key');

      const keyDecipher = createDecipheriv('aes-256-gcm', this.#masterKey, wrappedKeyIv, {
        authTagLength: GCM_TAG_BYTES,
      });
      keyDecipher.setAAD(keyMetadata);
      keyDecipher.setAuthTag(wrappedKeyTag);
      dataKey = Buffer.concat([keyDecipher.update(wrappedKey), keyDecipher.final()]);

      const credentialDecipher = createDecipheriv('aes-256-gcm', dataKey, iv, {
        authTagLength: GCM_TAG_BYTES,
      });
      credentialDecipher.setAAD(credentialMetadata);
      credentialDecipher.setAuthTag(tag);
      plaintextBuffer = Buffer.concat([
        credentialDecipher.update(ciphertext),
        credentialDecipher.final(),
      ]);

      return plaintextBuffer.toString('utf8') as SensitiveString;
    } catch {
      throw new CredentialVaultError('CREDENTIAL_DECRYPTION_FAILED');
    } finally {
      wrappedKey?.fill(0);
      wrappedKeyIv?.fill(0);
      wrappedKeyTag?.fill(0);
      ciphertext?.fill(0);
      iv?.fill(0);
      tag?.fill(0);
      dataKey?.fill(0);
      plaintextBuffer?.fill(0);
      credentialMetadata?.fill(0);
      keyMetadata?.fill(0);
    }
  }
}
