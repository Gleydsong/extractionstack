import { CrawledPage, DetectorResult, Dimension, Evidence } from '@extractionstack/shared';

export interface Detector<TData = unknown> {
  readonly dimension: Dimension;
  detect(page: CrawledPage): Promise<DetectorResult<TData>>;
}

export abstract class BaseDetector<TData = unknown> implements Detector<TData> {
  abstract readonly dimension: Dimension;
  abstract detect(page: CrawledPage): Promise<DetectorResult<TData>>;

  protected ok(data: TData, evidence: Evidence[] = []): DetectorResult<TData> {
    const result: DetectorResult<TData> = evidence.length
      ? { dimension: this.dimension, status: 'ok', data, evidence }
      : { dimension: this.dimension, status: 'ok', data };
    return result;
  }

  protected skipped(reason: string): DetectorResult<TData> {
    return { dimension: this.dimension, status: 'skipped', reason };
  }

  protected error(err: string): DetectorResult<TData> {
    return { dimension: this.dimension, status: 'error', error: err };
  }
}

export const ev = (
  source: Evidence['source'],
  snippet: string,
  confidence: Evidence['confidence'],
  note?: string,
): Evidence => (note ? { source, snippet, confidence, note } : { source, snippet, confidence });

export const evHigh = (source: Evidence['source'], snippet: string, note?: string): Evidence =>
  ev(source, snippet, 'high', note);

export const evMed = (source: Evidence['source'], snippet: string, note?: string): Evidence =>
  ev(source, snippet, 'medium', note);

export const evLow = (source: Evidence['source'], snippet: string, note?: string): Evidence =>
  ev(source, snippet, 'low', note);
