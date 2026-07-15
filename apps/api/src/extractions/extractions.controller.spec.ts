import { describe, expect, it, vi } from 'vitest';
import type { ExtractionsService } from './extractions.service.js';
import { ExtractionsController } from './extractions.controller.js';

describe('ExtractionsController', () => {
  it('passes only verified actor, validated command, and idempotency key to the service', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'cm1234567890' });
    const service = { create } as unknown as ExtractionsService;
    const controller = new ExtractionsController(service);
    const user = { sub: 'auth0|user-1', roles: ['user'] as ('user' | 'admin')[] };

    await controller.create(
      { user },
      { url: 'https://example.com' },
      'extract-request:0001',
    );

    expect(create).toHaveBeenCalledWith(
      user,
      { url: 'https://example.com' },
      'extract-request:0001',
    );
  });
});
