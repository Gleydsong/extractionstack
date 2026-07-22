import { useMemo } from 'react';
import { authClient } from '../auth/auth-client';
import { ExtractionApiClient } from '../../lib/api-client';

export function useExtractionApiClient(injected?: ExtractionApiClient): ExtractionApiClient {
  return useMemo(
    () =>
      injected ??
      new ExtractionApiClient(async () => authClient.getToken() ?? ''),
    [injected],
  );
}
