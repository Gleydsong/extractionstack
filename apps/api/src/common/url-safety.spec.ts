import { describe, expect, it } from 'vitest';
import { assertSafeTargetUrl, isPrivateIp, UrlNotAllowedError } from './url-safety.js';

describe('isPrivateIp', () => {
  it('blocks loopback and RFC1918 ranges', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
    expect(isPrivateIp('169.254.169.254')).toBe(true);
    expect(isPrivateIp('::1')).toBe(true);
  });

  it('allows public IPs', () => {
    expect(isPrivateIp('1.1.1.1')).toBe(false);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
  });
});

describe('assertSafeTargetUrl', () => {
  it('blocks localhost hostnames', async () => {
    await expect(assertSafeTargetUrl('http://localhost/')).rejects.toBeInstanceOf(
      UrlNotAllowedError,
    );
  });

  it('blocks private IPs', async () => {
    await expect(assertSafeTargetUrl('http://127.0.0.1/')).rejects.toBeInstanceOf(
      UrlNotAllowedError,
    );
    await expect(assertSafeTargetUrl('http://169.254.169.254/')).rejects.toBeInstanceOf(
      UrlNotAllowedError,
    );
    await expect(assertSafeTargetUrl('http://10.0.0.5/')).rejects.toBeInstanceOf(
      UrlNotAllowedError,
    );
  });

  it('blocks non-http(s) protocols', async () => {
    await expect(assertSafeTargetUrl('ftp://example.com/')).rejects.toBeInstanceOf(
      UrlNotAllowedError,
    );
  });

  it('allows public IP literals', async () => {
    await expect(assertSafeTargetUrl('https://1.1.1.1/')).resolves.toBeUndefined();
    await expect(assertSafeTargetUrl('https://8.8.8.8/')).resolves.toBeUndefined();
  });
});
