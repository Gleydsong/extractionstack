import { describe, expect, it } from 'vitest';
import { decodeCanonicalCredentialMasterKey } from './credential-master-key.js';

describe('decodeCanonicalCredentialMasterKey', () => {
  it('decodes only the exact canonical 44-character representation of 32 bytes', () => {
    const encoded = Buffer.alloc(32, 9).toString('base64');
    const decoded = decodeCanonicalCredentialMasterKey(encoded);

    expect(encoded).toHaveLength(44);
    expect(decoded).toHaveLength(32);
    decoded?.fill(0);
    expect(decodeCanonicalCredentialMasterKey(Buffer.alloc(31).toString('base64'))).toBeUndefined();
    expect(decodeCanonicalCredentialMasterKey(`${'A'.repeat(42)}B=`)).toBeUndefined();
  });

  it('rejects oversized input before attempting to decode it', () => {
    const oversized = `${'A'.repeat(100_000)}oversized-secret-marker`;

    expect(decodeCanonicalCredentialMasterKey(oversized)).toBeUndefined();
  });
});
