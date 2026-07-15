import { Provider } from '@nestjs/common';
import { Detector } from './detector.interface.js';
import { CssFrameworkDetector } from './css-framework.detector.js';
import { CssCustomizationDetector } from './css-customization.detector.js';
import { DesignSystemDetector } from './design-system.detector.js';
import { TypographyDetector } from './typography.detector.js';
import { ResponsiveDetector } from './responsive.detector.js';
import { GridSystemDetector } from './grid-system.detector.js';
import { AnimationDetector } from './animation.detector.js';
import { ScrollAnimationDetector } from './scroll-animation.detector.js';
import { TransitionDetector } from './transition.detector.js';
import { SeoDetector } from './seo.detector.js';
import { PerformanceDetector } from './performance.detector.js';
import { ComponentArchitectureDetector } from './component-architecture.detector.js';
import { DesignTokensDetector } from './design-tokens.detector.js';
import { PaletteDetector } from './palette.detector.js';
import { IconsDetector } from './icons.detector.js';
import { BackendFrameworkDetector } from './backend-framework.detector.js';
import { LanguageDetector } from './language.detector.js';
import { LibrariesDetector } from './libraries.detector.js';
import { StateManagementDetector } from './state-management.detector.js';
import { RoutingDetector } from './routing.detector.js';
import { AuthProviderDetector } from './auth-provider.detector.js';
import { ApisConsumedDetector } from './apis-consumed.detector.js';
import { ThirdPartyServicesDetector } from './third-party-services.detector.js';
import { AnalyticsDetector } from './analytics.detector.js';
import { CdnDetector } from './cdn.detector.js';
import { CloudProviderDetector } from './cloud-provider.detector.js';
import { ReverseProxyDetector } from './reverse-proxy.detector.js';
import { DatabaseIndicatorsDetector } from './database-indicators.detector.js';
import { DockerKubernetesDetector } from './docker-kubernetes.detector.js';
import { ArchitectureDetector } from './architecture.detector.js';

export const DETECTORS_TOKEN = 'DETECTORS';
export const RESPONSIVE_GRID_MERGE_KEY = 'responsive' as const;

const ALL: Detector[] = [
  new CssFrameworkDetector(),
  new CssCustomizationDetector(),
  new DesignSystemDetector(),
  new TypographyDetector(),
  new ResponsiveDetector(),
  new GridSystemDetector(),
  new AnimationDetector(),
  new ScrollAnimationDetector(),
  new TransitionDetector(),
  new SeoDetector(),
  new PerformanceDetector(),
  new ComponentArchitectureDetector(),
  new DesignTokensDetector(),
  new PaletteDetector(),
  new IconsDetector(),
  new BackendFrameworkDetector(),
  new LanguageDetector(),
  new LibrariesDetector(),
  new StateManagementDetector(),
  new RoutingDetector(),
  new AuthProviderDetector(),
  new ApisConsumedDetector(),
  new ThirdPartyServicesDetector(),
  new AnalyticsDetector(),
  new CdnDetector(),
  new CloudProviderDetector(),
  new ReverseProxyDetector(),
  new DatabaseIndicatorsDetector(),
  new DockerKubernetesDetector(),
  new ArchitectureDetector(),
];

export const DETECTOR_LIST: Detector[] = ALL;

export const DETECTORS: Provider[] = [
  {
    provide: DETECTORS_TOKEN,
    useFactory: (): Detector[] => ALL,
  },
];
