import { CrawledPage } from '@extractionstack/shared';
import { BaseDetector, evHigh, evMed, evLow } from './detector.interface.js';

interface ApisConsumedData {
  endpoints: { url: string; method: string; contentType: string | null; status: number | undefined }[];
  rest: { count: number; hosts: string[] };
  graphql: { count: number; endpoints: string[] };
  totalRequests: number;
  totalTransferBytes: number;
}

const REST_HINTS = [/\/api\//, /\.json(\?|$|#)/, /\/v\d+\//, /\/rest\//];
const GRAPHQL_HINTS = [/\/graphql(\?|$|#)/, /\/gql(\?|$|#)/];

export class ApisConsumedDetector extends BaseDetector<ApisConsumedData> {
  readonly dimension = 'apisConsumed' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<ApisConsumedData>> {
    const endpoints: ApisConsumedData['endpoints'] = [];
    const restHosts = new Set<string>();
    const graphqlEndpoints = new Set<string>();
    const evidence: import('@extractionstack/shared').Evidence[] = [];
    let restCount = 0;
    let graphqlCount = 0;
    let totalBytes = 0;

    for (const n of page.networkLog) {
      if (n.resourceType === 'xhr' || n.resourceType === 'fetch') {
        endpoints.push({
          url: n.url,
          method: n.method,
          contentType: n.contentType ?? null,
          status: n.status,
        });
        if (n.size) totalBytes += n.size;
        let host: string | null = null;
        let path: string | null = null;
        try {
          const u = new URL(n.url);
          host = u.host;
          path = u.pathname + u.search;
        } catch {
          void host;
        }
        if (!path) continue;
        if (GRAPHQL_HINTS.some((p) => p.test(path))) {
          graphqlCount++;
          graphqlEndpoints.add(n.url);
          evidence.push(evHigh('network', `GraphQL call ${n.method} ${n.url.slice(0, 80)}`));
        } else if (REST_HINTS.some((p) => p.test(path)) || n.contentType?.includes('json')) {
          if (host) restHosts.add(host);
          restCount++;
          if (restCount <= 5) {
            evidence.push(
              n.contentType?.includes('json')
                ? evHigh('network', `${n.method} ${n.url.slice(0, 80)} (json)`)
                : evMed('network', `${n.method} ${n.url.slice(0, 80)}`),
            );
          }
        } else if (n.resourceType === 'fetch' || n.resourceType === 'xhr') {
          evidence.push(evLow('network', `untyped ${n.method} ${n.url.slice(0, 80)}`));
        }
      }
    }

    if (page.html.includes('"graphql"') || /ApolloClient|createHttpLink\(.*graphql/i.test(page.html)) {
      graphqlCount++;
      evidence.push(evHigh('script', 'Apollo/graphql client marker in HTML'));
    }

    return this.ok(
      {
        endpoints: endpoints.slice(0, 50),
        rest: { count: restCount, hosts: Array.from(restHosts) },
        graphql: { count: graphqlCount, endpoints: Array.from(graphqlEndpoints) },
        totalRequests: page.networkLog.length,
        totalTransferBytes: totalBytes,
      },
      evidence,
    );
  }
}
