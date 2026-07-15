import { useMemo } from 'react';
import { useAppAuth } from '../auth/WebAuthProvider';
import { ExtractionApiClient } from '../../lib/api-client';

export function useExtractionApiClient(injected?: ExtractionApiClient): ExtractionApiClient {
  const { getAccessTokenSilently } = useAppAuth();
  return useMemo(
    () => injected ?? new ExtractionApiClient(getAccessTokenSilently),
    [getAccessTokenSilently, injected],
  );
}
