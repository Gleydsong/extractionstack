import type { PromptLayer } from '../providers/provider-adapter';
import { ProviderFailure } from '../providers/provider-errors';
import type { ComposedPrompt } from './prompt-composer';

export function composedPromptLayers(composed: ComposedPrompt): readonly PromptLayer[] {
  return Object.freeze([
    Object.freeze({ kind: 'platform-policy' as const, content: composed.system }),
    Object.freeze({ kind: 'task' as const, content: composed.userTask }),
    Object.freeze({ kind: 'source-context' as const, content: composed.sourceData }),
    Object.freeze({ kind: 'destination-rules' as const, content: composed.destinationRules }),
    Object.freeze({ kind: 'response-contract' as const, content: composed.outputContract }),
  ]);
}

export function conservativeInputTokenUpperBound(layers: readonly PromptLayer[]): number {
  const protocolOverheadBytes = 2_048;
  const encoder = new TextEncoder();
  const bytes = layers.reduce(
    (total, layer) =>
      total + encoder.encode(layer.kind).byteLength + encoder.encode(layer.content).byteLength + 64,
    protocolOverheadBytes,
  );
  if (!Number.isSafeInteger(bytes) || bytes > 2_147_483_647) {
    throw new ProviderFailure('INPUT_INVALID');
  }
  return bytes;
}
