import { useEffect } from 'react';

/** Canal de tempo real (SSE). Um único EventSource para a aba inteira. */
type Handler = (data: any) => void;
const handlers = new Map<string, Set<Handler>>();
let source: EventSource | null = null;
let statusListeners = new Set<(s: boolean) => void>();
export let realtimeConnected = false;

function setStatus(v: boolean) {
  realtimeConnected = v;
  statusListeners.forEach((l) => l(v));
}

export function connectRealtime() {
  if (source) return;
  source = new EventSource('/api/events');
  source.onopen = () => setStatus(true);
  source.onerror = () => setStatus(false);
  for (const type of ['data', 'tracking', 'update']) {
    source.addEventListener(type, (ev) => {
      let data: any = null;
      try { data = JSON.parse((ev as MessageEvent).data); } catch { return; }
      handlers.get(type)?.forEach((h) => h(data));
    });
  }
}

export function disconnectRealtime() {
  source?.close();
  source = null;
  setStatus(false);
}

export function onRealtimeStatus(fn: (s: boolean) => void) {
  statusListeners.add(fn);
  return () => { statusListeners.delete(fn); };
}

export function useRealtime(type: 'data' | 'tracking' | 'update', handler: Handler, deps: unknown[] = []) {
  useEffect(() => {
    const set = handlers.get(type) ?? handlers.set(type, new Set()).get(type)!;
    set.add(handler);
    return () => { set.delete(handler); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
