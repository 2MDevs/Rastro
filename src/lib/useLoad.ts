import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

/** Carrega dados de forma simples: { data, error, loading, reload } */
export function useLoad<T>(fn: (signal: AbortSignal) => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const ctrl = useRef<AbortController | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(async (quiet = false) => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    if (!quiet) setLoading(true);
    try {
      const d = await fnRef.current(c.signal);
      if (!c.signal.aborted) { setData(d); setError(null); }
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      if (!c.signal.aborted) setError(err instanceof ApiError ? err.message : 'Não foi possível carregar.');
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
    return () => ctrl.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, setData, error, loading, reload };
}
