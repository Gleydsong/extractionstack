import { CrawledPage } from '@extractionstack/shared';
import { BaseDetector, evHigh, evMed, evLow } from './detector.interface.js';

interface DockerKubernetesData {
  docker: string[];
  kubernetes: string[];
}

const DOCKER_HEADERS: RegExp[] = [];

export class DockerKubernetesDetector extends BaseDetector<DockerKubernetesData> {
  readonly dimension = 'dockerKubernetes' as const;

  async detect(page: CrawledPage): Promise<import('@extractionstack/shared').DetectorResult<DockerKubernetesData>> {
    const docker: string[] = [];
    const k8s: string[] = [];
    const evidence: import('@extractionstack/shared').Evidence[] = [];

    if (page.networkLog.some((n) => /\/healthz|\/readyz|\/livez/.test(n.url))) {
      k8s.push('healthz endpoint');
      evidence.push(evHigh('network', 'Kubernetes health endpoint observed'));
    }
    for (const [k, v] of Object.entries(page.headers)) {
      if (DOCKER_HEADERS.some((p) => p.test(`${k}: ${v}`))) {
        docker.push(`${k}: ${v}`);
        evidence.push(evMed('header', `Docker: ${k}: ${v}`));
      }
    }
    for (const n of page.networkLog) {
      if (n.url.includes('.docker.io') || n.url.includes('docker.com')) {
        docker.push(n.url);
        evidence.push(evMed('network', `Docker registry: ${n.url.slice(0, 80)}`));
      }
      if (n.url.includes('k8s.io') || n.url.includes('kubernetes')) {
        k8s.push(n.url);
        evidence.push(evHigh('network', `Kubernetes URL: ${n.url.slice(0, 80)}`));
      }
    }

    return this.ok({ docker: Array.from(new Set(docker)), kubernetes: Array.from(new Set(k8s)) }, evidence);
  }
}
