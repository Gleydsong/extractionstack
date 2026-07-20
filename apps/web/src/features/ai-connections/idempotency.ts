import { isUncertainAiConnectionsError, type ApiKeyCommand } from './useAiConnectionsApi';

type PendingOperation = Readonly<{ key: string; fingerprint: string }>;

export class IdempotencyOperationStore {
  private readonly pending = new Map<string, PendingOperation>();

  constructor(private readonly createKey: (prefix: string) => string = createIdempotencyKey) {}

  acquire(operation: string, prefix: string, fingerprint = ''): string {
    const current = this.pending.get(operation);
    if (current?.fingerprint === fingerprint) return current.key;

    const key = this.createKey(prefix);
    this.pending.set(operation, { key, fingerprint });
    return key;
  }

  settle(operation: string, error?: unknown): void {
    if (error === undefined || !isUncertainAiConnectionsError(error)) {
      this.pending.delete(operation);
    }
  }
}

export async function fingerprintApiKeyCommand(command: ApiKeyCommand): Promise<string> {
  const input = new TextEncoder().encode(
    JSON.stringify([command.provider, command.displayLabel, command.apiKey]),
  );
  const digest = await crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function createIdempotencyKey(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}
