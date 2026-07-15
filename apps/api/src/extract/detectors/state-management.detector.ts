import type { CrawledPage } from '@extractionstack/shared';
import { BaseDetector, evMed } from './detector.interface.js';

interface StateManagementData {
  detected: string[];
  primary: string | null;
}

const SIGNATURES: Array<{ name: string; patterns: RegExp[] }> = [
  { name: 'redux', patterns: [/__REDUX_DEVTOOLS_EXTENSION__|createStore\(|configureStore\(/] },
  { name: 'redux-toolkit', patterns: [/@reduxjs\/toolkit|createSlice\(/] },
  { name: 'zustand', patterns: [/zustand|create\(\)\(set/] },
  { name: 'mobx', patterns: [/mobx|makeAutoObservable/] },
  { name: 'jotai', patterns: [/jotai|atom\(\)/] },
  { name: 'recoil', patterns: [/recoil|RecoilRoot/] },
  { name: 'xstate', patterns: [/xstate|createMachine\(/] },
  { name: 'pinia', patterns: [/pinia|defineStore\(/] },
  { name: 'vuex', patterns: [/vuex|createStore\(.*modules/] },
  { name: 'valtio', patterns: [/valtio|proxyWithComputed/] },
  { name: 'ngrx', patterns: [/@ngrx\/store|createReducer\(/] },
];

export class StateManagementDetector extends BaseDetector<StateManagementData> {
  readonly dimension = 'stateManagement' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<StateManagementData>> {
    const hits: { name: string; snippet: string }[] = [];
    const evidence: import('@extractionstack/shared').Evidence[] = [];
    for (const sig of SIGNATURES) {
      for (const s of page.scripts) {
        const blob = (s.src ?? '') + ' ' + (s.content ?? '');
        if (sig.patterns.some((p) => p.test(blob))) {
          hits.push({ name: sig.name, snippet: (s.src ?? s.content ?? '').slice(0, 100) });
          evidence.push(evMed('script', `${sig.name} in ${(s.src ?? 'inline script').slice(0, 80)}`));
          break;
        }
      }
      if (!hits.find((h) => h.name === sig.name) && sig.patterns.some((p) => p.test(page.html))) {
        hits.push({ name: sig.name, snippet: 'inline html' });
        evidence.push(evMed('html', `${sig.name} marker in HTML`));
      }
    }
    const detected = Array.from(new Set(hits.map((h) => h.name)));
    if (detected.length === 0) {
      return this.ok({ detected: [], primary: null });
    }
    return this.ok({ detected, primary: detected[0] ?? null }, evidence);
  }
}
