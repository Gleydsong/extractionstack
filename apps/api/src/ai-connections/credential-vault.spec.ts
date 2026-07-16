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

function tamperBase64(value: string): string {
  return `${value.startsWith('A') ? 'B' : 'A'}${value.slice(1)}`;
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
      expect(Object.values(failure as object).join(' ')).not.toContain(
        'tampered-secret-bearing-input',
      );
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

  it('returns exact cryptographic sizes in a frozen envelope', async () => {
    const envelope = await createVault().encrypt('owner-a', 'OPENAI', 'sk-secret');

    expect(Buffer.from(envelope.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(envelope.tag, 'base64')).toHaveLength(16);
    expect(Buffer.from(envelope.wrappedKeyIv, 'base64')).toHaveLength(12);
    expect(Buffer.from(envelope.wrappedKeyTag, 'base64')).toHaveLength(16);
    expect(Buffer.from(envelope.wrappedKey, 'base64')).toHaveLength(32);
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Reflect.set(envelope, 'keyVersion', 'mutated')).toBe(false);
    expect(envelope.keyVersion).toBe('test-v1');
  });

  it.each(['ciphertext', 'iv', 'tag'] as const)(
    'fails safely when the credential GCM %s is tampered',
    async (field) => {
      const vault = createVault();
      const envelope = await vault.encrypt('owner-a', 'OPENAI', 'sk-secret');

      await expect(
        vault.decrypt('owner-a', 'OPENAI', {
          ...envelope,
          [field]: tamperBase64(envelope[field]),
        }),
      ).rejects.toMatchObject({ code: 'CREDENTIAL_DECRYPTION_FAILED' });
    },
  );

  it.each(['wrappedKey', 'wrappedKeyIv', 'wrappedKeyTag'] as const)(
    'fails safely when the data-key GCM %s is tampered',
    async (field) => {
      const vault = createVault();
      const envelope = await vault.encrypt('owner-a', 'OPENAI', 'sk-secret');

      await expect(
        vault.decrypt('owner-a', 'OPENAI', {
          ...envelope,
          [field]: tamperBase64(envelope[field]),
        }),
      ).rejects.toMatchObject({ code: 'CREDENTIAL_DECRYPTION_FAILED' });
    },
  );

  it('rejects unknown envelope keys before decryption', async () => {
    const vault = createVault();
    const envelope = await vault.encrypt('owner-a', 'OPENAI', 'sk-secret');

    await expect(
      vault.decrypt('owner-a', 'OPENAI', {
        ...envelope,
        unexpectedSecret: 'must-not-be-accepted',
      } as CredentialEnvelope),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_DECRYPTION_FAILED' });
  });

  it.each([
    ['wrappedKey', Buffer.alloc(31).toString('base64')],
    ['wrappedKeyIv', Buffer.alloc(11).toString('base64')],
    ['wrappedKeyTag', Buffer.alloc(15).toString('base64')],
    ['iv', Buffer.alloc(11).toString('base64')],
    ['tag', Buffer.alloc(15).toString('base64')],
    ['ciphertext', ''],
  ] as const)('rejects an envelope with the wrong decoded %s length', async (field, value) => {
    const vault = createVault();
    const envelope = await vault.encrypt('owner-a', 'OPENAI', 'sk-secret');

    await expect(
      vault.decrypt('owner-a', 'OPENAI', { ...envelope, [field]: value }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_DECRYPTION_FAILED' });
  });

  it('rejects oversized ciphertext before decoding it', async () => {
    const vault = createVault();
    const envelope = await vault.encrypt('owner-a', 'OPENAI', 'sk-secret');

    await expect(
      vault.decrypt('owner-a', 'OPENAI', {
        ...envelope,
        ciphertext: 'A'.repeat(87_388),
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_DECRYPTION_FAILED' });
  });

  it('rejects noncanonical base64 before decryption', async () => {
    const vault = createVault();
    const envelope = await vault.encrypt('owner-a', 'OPENAI', 'sk-secret');
    const noncanonicalTag = `${'A'.repeat(21)}B==`;

    expect(Buffer.from(noncanonicalTag, 'base64').toString('base64')).not.toBe(noncanonicalTag);
    await expect(
      vault.decrypt('owner-a', 'OPENAI', { ...envelope, tag: noncanonicalTag }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_DECRYPTION_FAILED' });
  });

  it('rejects invalid algorithm and key-version shapes', async () => {
    const vault = createVault();
    const envelope = await vault.encrypt('owner-a', 'OPENAI', 'sk-secret');

    await expect(
      vault.decrypt('owner-a', 'OPENAI', {
        ...envelope,
        algorithm: 'AES-128-GCM',
      } as unknown as CredentialEnvelope),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_DECRYPTION_FAILED' });
    await expect(
      vault.decrypt('owner-a', 'OPENAI', {
        ...envelope,
        keyVersion: 'x'.repeat(65),
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_DECRYPTION_FAILED' });
  });
});
