import { CrawledPage } from '@extractionstack/shared';
import { BaseDetector, evHigh, evMed } from './detector.interface.js';

interface LanguageData {
  primary: string | null;
  detected: string[];
  indicators: { language: string; snippet: string }[];
}

const JS_PATTERNS: RegExp[] = [
  /<script\b[^>]*>[\s\S]{0,500}?(?:=>|const |let |function )/,
  /\bwindow\.__NEXT_DATA__/,
  /type="module"/,
];
const TS_PATTERNS: RegExp[] = [/\.tsx?\b/, /@typescript-eslint/i];
const HTML_PATTERNS: RegExp[] = [/<!doctype html/i, /<html\b/];
const CSS_PATTERNS: RegExp[] = [/\.css\b/, /@import\s+url/];
const PYTHON_PATTERNS: RegExp[] = [/csrfmiddlewaretoken/, /__cf_bm/];
const PHP_PATTERNS: RegExp[] = [/\.php\b/, /PHPSESSID/, /<meta name="generator" content="WordPress/i];

const SCRIPT_EXT_RE = /\.([a-z]{2,5})(\?|$|#)/i;

export class LanguageDetector extends BaseDetector<LanguageData> {
  readonly dimension = 'language' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<LanguageData>> {
    const detected = new Map<string, number>();
    const indicators: { language: string; snippet: string }[] = [];
    const evidence: import('@extractionstack/shared').Evidence[] = [];

    const tag = (lang: string, snippet: string, conf: 'high' | 'medium' = 'high') => {
      detected.set(lang, (detected.get(lang) ?? 0) + 1);
      indicators.push({ language: lang, snippet: snippet.slice(0, 120) });
      evidence.push(conf === 'high' ? evHigh('html', snippet) : evMed('html', snippet));
    };

    if (HTML_PATTERNS.some((p) => p.test(page.html))) tag('HTML', '<!doctype html>');
    if (JS_PATTERNS.some((p) => p.test(page.html))) tag('JavaScript', '<script> with JS markers');
    if (TS_PATTERNS.some((p) => p.test(page.html))) tag('TypeScript', 'TS markers in HTML/JS');
    if (CSS_PATTERNS.some((p) => p.test(page.html))) tag('CSS', 'CSS markers in HTML');

    for (const s of page.scripts) {
      const src = s.src ?? '';
      const m = SCRIPT_EXT_RE.exec(src);
      if (m?.[1] === 'js') tag('JavaScript', `script src .js: ${src.slice(0, 80)}`);
      if (m?.[1] === 'ts' || m?.[1] === 'tsx') tag('TypeScript', `script src .${m[1]}: ${src.slice(0, 80)}`);
      if (m?.[1] === 'mjs') tag('JavaScript (ESM)', `script src .mjs: ${src.slice(0, 80)}`);
    }
    for (const l of page.stylesheets) {
      const href = l.href ?? '';
      if (/\.css(\?|$|#)/i.test(href)) tag('CSS', `link .css: ${href.slice(0, 80)}`);
      if (/\.scss(\?|$|#)/i.test(href)) tag('SCSS', `link .scss: ${href.slice(0, 80)}`);
    }

    if (PYTHON_PATTERNS.some((p) => p.test(page.html))) tag('Python (server hint)', 'Django/CSRF token in HTML');
    if (PHP_PATTERNS.some((p) => p.test(page.html))) tag('PHP (server hint)', 'PHP markers in HTML/cookies');

    if (page.headers['x-powered-by']) {
      const xp = page.headers['x-powered-by'];
      if (/PHP/i.test(xp)) tag('PHP', `X-Powered-By: ${xp}`);
      if (/ASP\.NET/i.test(xp)) tag('C#', `X-Powered-By: ${xp}`);
    }

    const ordered = Array.from(detected.entries()).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    return this.ok(
      { primary: ordered[0] ?? null, detected: ordered, indicators },
      evidence,
    );
  }
}
