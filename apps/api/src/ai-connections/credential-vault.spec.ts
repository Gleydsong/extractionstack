import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CredentialVault,
  CredentialVaultError,
  type CredentialEnvelope,
} from './credential-vault.js';

const masterKey = randomBytes(32).toString('base64');

function createVault(key = masterKey, keyVersion = 'test-v1'): CredentialVault {
  return new CredentialVault(key, keyVersion);
}

describe('CredentialVault', () => {
  it('round-trips a credential through envelope encryption', async () => {
    const vault = createVault();
    const envelope = await vault.encrypt('owner-a', 'OPENAI', 'sk-secret');

    await expect(vault.decrypt('owner-a', 'OPENAI', envelope)).resolves.toBe('sk-secret');
  });

  it('binds ciphertext to owner and provider metadata', async () => {
    const vault = createVault();
    const envelope = await vault.encrypt('owner-a', 'OPENAI', 'sk-secret');

    await expect(vault.decrypt('owner-b', 'OPENAI', envelope)).rejects.toThrow(
      'CREDENTIAL_DECRYPTION_FAILED',
    );
    await expect(vault.decrypt('owner-a', 'GEMINI', envelope)).rejects.toThrow(
      'CREDENTIAL_DECRYPTION_FAILED',
    );
  });

  it('binds ciphertext to the configured key version', async () => {
    const vault = createVault();
    const envelope = await vault.encrypt('owner-a', 'OPENAI', 'sk-secret');
    const wrongVersionEnvelope = { ...envelope, keyVersion: 'test-v2' };

    await expect(vault.decrypt('owner-a', 'OPENAI', wrongVersionEnvelope)).rejects.toThrow(
      'CREDENTIAL_DECRYPTION_FAILED',
    );
  });

  it('rejects malformed and tampered envelopes with a safe error', async () => {
    const vault = createVault();
    const envelope = await vault.encrypt('owner-a', 'OPENAI', 'sk-secret');
    const malformed = { ...envelope, iv: 'not-base64!' } as CredentialEnvelope;
    const tampered = {
      ...envelope,
      ciphertext: Buffer.from('tampered-secret-bearing-input').toString('base64'),
    };

    for (const rejectedEnvelope of [malformed, tampered]) {
      let failure: unknown;

      try {
        await vault.decrypt('owner-a', 'OPENAI', rejectedEnvelope);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(CredentialVaultError);
      expect(failure).toMatchObject({ code: 'CREDENTIAL_DECRYPTION_FAILED' });
      expect(failure).not.toHaveProperty('cause');
      expect(JSON.stringify(failure)).not.toContain('tampered-secret-bearing-input');
      expect(Object.values(failure as object).join(' ')).not.toContain('tampered-secret-bearing-input');
    }
  });

  it('rejects a master key that does not decode to exactly 32 bytes', () => {
    expect(() => createVault(randomBytes(31).toString('base64'))).toThrow(
      'CREDENTIAL_VAULT_CONFIGURATION_INVALID',
    );
    expect(() => createVault('not-base64!')).toThrow('CREDENTIAL_VAULT_CONFIGURATION_INVALID');
  });

  it('does not include plaintext or the master key in serialized vault data', async () => {
    const vault = createVault();
    const envelope = await vault.encrypt('owner-a', 'OPENAI', 'sk-secret');

    expect(JSON.stringify(envelope)).not.toContain('sk-secret');
    expect(JSON.stringify(vault)).not.toContain(masterKey);
    expect(JSON.stringify(vault)).not.toContain('sk-secret');
  });

  it('uses independent data keys and IVs for every encryption', async () => {
    const vault = createVault();
    const first = await vault.encrypt('owner-a', 'OPENAI', 'sk-secret');
    const second = await vault.encrypt('owner-a', 'OPENAI', 'sk-secret');

    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.wrappedKey).not.toBe(second.wrappedKey);
    expect(first.iv).not.toBe(second.iv);
    expect(first.wrappedKeyIv).not.toBe(second.wrappedKeyIv);
  });
});
