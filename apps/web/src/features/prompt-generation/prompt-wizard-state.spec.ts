import { describe, expect, it } from 'vitest';
import { initialPromptWizardState, promptWizardReducer } from './prompt-wizard-state';

describe('promptWizardReducer', () => {
  it('blocks invalid intent with natural field errors', () => {
    const state = promptWizardReducer(initialPromptWizardState('cm1234567890extract'), {
      type: 'next',
    });
    expect(state.step).toBe('intent');
    expect(state.errors.objective).toMatch(/objetivo/i);
    expect(state.errors.audience).toMatch(/público/i);
  });

  it('preserves free-form and guided values across review and back', () => {
    let state = initialPromptWizardState('cm1234567890extract');
    for (const [field, value] of [
      ['objective', 'Criar uma aplicação acessível.'],
      ['audience', 'Desenvolvedores'],
      ['freeInstructions', 'Use arquitetura modular.'],
    ] as const)
      state = promptWizardReducer(state, { type: 'set-field', field, value });
    state = promptWizardReducer(state, { type: 'next' });
    expect(state.step).toBe('requirements');
    state = promptWizardReducer(state, { type: 'review' });
    expect(state.step).toBe('review');
    state = promptWizardReducer(state, { type: 'back' });
    expect(state.step).toBe('requirements');
    expect(state.draft.freeInstructions).toBe('Use arquitetura modular.');
    expect(state.draft.objective).toBe('Criar uma aplicação acessível.');
  });
});
