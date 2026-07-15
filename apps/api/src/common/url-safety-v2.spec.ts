import { describe, expect, it } from 'vitest';
import {
  assertSafeRedirectChain,
  assertSafeTargetUrl,
  isPrivateIp,
  UrlNotAllowedError,
  type DnsResolver,
} from './url-safety.js';

const publicResolver: DnsResolver = async () => [{ address: '93.184.216.34', family: 4 }];

describe('URL safety v2', () => {
  it.each([
    '0.0.0.0',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '192.0.2.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1',
  ])('classifies %s as non-public', (address) => {
    expect(isPrivateIp(address)).toBe(true);
  });

  it.each([
    'http://user:pass@example.com',
    'http://example.com:2375',
    'https://example.com:8443',
    `https://example.com/${'x'.repeat(2049)}`,
  ])('rejects unsafe URL syntax %s', async (url) => {
    await expect(assertSafeTargetUrl(url, publicResolver)).rejects.toBeInstanceOf(
      UrlNotAllowedError,
    );
  });

  it('rejects a hostname with mixed public and private DNS answers', async () => {
    const resolver: DnsResolver = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.10', family: 4 },
    ];

    await expect(assertSafeTargetUrl('https://example.com', resolver)).rejects.toMatchObject({
      reason: expect.stringContaining('non-public'),
    });
  });

  it('revalidates every redirect target', async () => {
    await expect(
      assertSafeRedirectChain(
        ['https://example.com', 'http://169.254.169.254/latest/meta-data'],
        publicResolver,
      ),
    ).rejects.toBeInstanceOf(UrlNotAllowedError);
  });

  it('accepts a bounded URL resolving only to public addresses', async () => {
    await expect(
      assertSafeTargetUrl('https://example.com/path', publicResolver),
    ).resolves.toBeUndefined();
  });
});
