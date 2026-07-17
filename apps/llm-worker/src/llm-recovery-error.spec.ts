import { describe, expect, it } from 'vitest';
import { classifyRecoveryError } from './llm-recovery-error';

describe('classifyRecoveryError', () => {
  it('classifies unique races as idempotent and transaction conflicts as transient', () => {
    expect(classifyRecoveryError({ code: 'P2002' })).toBe('IDEMPOTENT');
    expect(classifyRecoveryError({ code: 'P2034' })).toBe('TRANSIENT');
  });

  it('classifies invalid financial state as permanent', () => {
    expect(classifyRecoveryError(new Error('CREDIT_COST_LIMIT_EXCEEDED'))).toBe('PERMANENT');
    expect(classifyRecoveryError(new Error('CREDIT_STATE_INVALID'))).toBe('PERMANENT');
  });
});
