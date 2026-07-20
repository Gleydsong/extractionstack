import { PromptWizardInputSchema, type PromptWizardInput } from '@extractionstack/shared';

export type PromptWizardState = Readonly<{
  step: 'intent' | 'requirements' | 'review';
  draft: PromptWizardInput;
  errors: Readonly<Record<string, string>>;
}>;

export type PromptWizardAction =
  | {
      type: 'set-field';
      field: keyof PromptWizardInput;
      value: PromptWizardInput[keyof PromptWizardInput];
    }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'review' }
  | { type: 'reset'; extractionId: string };

export function initialPromptWizardState(extractionId: string): PromptWizardState {
  return {
    step: 'intent',
    draft: {
      extractionId,
      category: 'application',
      objective: '',
      audience: '',
      technologies: [],
      exclusions: [],
      requirements: [],
      language: 'pt-BR',
      detail: 'balanced',
      destination: 'universal',
      freeInstructions: '',
    },
    errors: {},
  };
}

export function promptWizardReducer(
  state: PromptWizardState,
  action: PromptWizardAction,
): PromptWizardState {
  if (action.type === 'reset') return initialPromptWizardState(action.extractionId);
  if (action.type === 'set-field') {
    return { ...state, draft: { ...state.draft, [action.field]: action.value }, errors: {} };
  }
  if (action.type === 'back') {
    return { ...state, step: state.step === 'review' ? 'requirements' : 'intent', errors: {} };
  }
  if (action.type === 'next') {
    const errors = validateIntent(state.draft);
    return Object.keys(errors).length > 0
      ? { ...state, errors }
      : { ...state, step: 'requirements', errors: {} };
  }
  const parsed = PromptWizardInputSchema.safeParse(state.draft);
  if (parsed.success) return { ...state, step: 'review', draft: parsed.data, errors: {} };
  return {
    ...state,
    errors: Object.fromEntries(
      parsed.error.issues.map((issue) => [
        String(issue.path[0] ?? 'form'),
        naturalIssue(issue.path[0]),
      ]),
    ),
  };
}

function validateIntent(draft: PromptWizardInput): Record<string, string> {
  const parsed = PromptWizardInputSchema.pick({
    extractionId: true,
    category: true,
    objective: true,
    audience: true,
  }).safeParse({
    extractionId: draft.extractionId,
    category: draft.category,
    objective: draft.objective,
    audience: draft.audience,
  });
  return parsed.success
    ? {}
    : Object.fromEntries(
        parsed.error.issues.map((issue) => [String(issue.path[0]), naturalIssue(issue.path[0])]),
      );
}

function naturalIssue(field: PropertyKey | undefined): string {
  const labels: Partial<Record<PropertyKey, string>> = {
    objective: 'Descreva o objetivo com pelo menos 10 caracteres.',
    audience: 'Informe o público-alvo.',
  };
  return labels[field ?? ''] ?? 'Revise este campo antes de continuar.';
}
