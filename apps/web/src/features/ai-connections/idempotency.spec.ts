import { describe, expect, it } from 'vitest';
import { AiConnectionsClientError } from './useAiConnectionsApi';
import { IdempotencyOperationStore } from './idempotency';

describe('IdempotencyOperationStore', () => {
  it('retains uncertain operations and clears successful or definitive outcomes', () => {
    let sequence = 0;
    const store = new IdempotencyOperationStore((prefix) => `${prefix}:${++sequence}`);

    const first = store.acquire('add', 'ai-connect', 'credential-a');
    store.settle('add', new AiConnectionsClientError('NETWORK_ERROR'));
    expect(store.acquire('add', 'ai-connect', 'credential-a')).toBe(first);

    store.settle('add', new AiConnectionsClientError('CONNECTION_INVALID'));
    expect(store.acquire('add', 'ai-connect', 'credential-a')).not.toBe(first);

    const third = store.acquire('validate:1', 'ai-validate');
    store.settle('validate:1');
    expect(store.acquire('validate:1', 'ai-validate')).not.toBe(third);
  });

  it('rotates the key when an add-key credential fingerprint changes', () => {
    let sequence = 0;
    const store = new IdempotencyOperationStore((prefix) => `${prefix}:${++sequence}`);

    const first = store.acquire('add', 'ai-connect', 'credential-a');
    expect(store.acquire('add', 'ai-connect', 'credential-b')).not.toBe(first);
  });
});
