/** Cliente da API: trata sessão expirada, tela bloqueada e confirmação de senha em um só lugar. */

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public data?: any) {
    super(message);
  }
}

type Listener = (code: string) => void;
const listeners = new Set<Listener>();
/** Avisos globais: NO_SESSION, SESSION_LOCKED, MUST_CHANGE_PASSWORD */
export function onApiSignal(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal; raw?: BodyInit; headers?: Record<string, string> } = {}): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(path, {
      method: opts.method ?? (opts.body !== undefined || opts.raw ? 'POST' : 'GET'),
      credentials: 'same-origin',
      headers: opts.raw ? opts.headers : { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
      body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
      signal: opts.signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, 'Sem conexão com o servidor. Verifique a internet e tente de novo.', 'OFFLINE');
  }
  const type = resp.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await resp.json().catch(() => null) : null;
  if (!resp.ok) {
    const code = data?.code as string | undefined;
    const message = data?.error || (resp.status >= 500 ? 'O servidor encontrou um problema. Tente de novo em instantes.' : 'Não foi possível concluir.');
    if (code && ['NO_SESSION', 'SESSION_LOCKED', 'MUST_CHANGE_PASSWORD'].includes(code)) listeners.forEach((l) => l(code));
    throw new ApiError(resp.status, message, code, data);
  }
  return (data ?? (await resp.text().catch(() => null))) as T;
}

export const get = <T = any>(p: string, signal?: AbortSignal) => api<T>(p, { signal });
export const post = <T = any>(p: string, body?: unknown) => api<T>(p, { method: 'POST', body: body ?? {} });
export const patch = <T = any>(p: string, body: unknown) => api<T>(p, { method: 'PATCH', body });
export const put = <T = any>(p: string, body: unknown) => api<T>(p, { method: 'PUT', body });
export const del = <T = any>(p: string, body?: unknown) => api<T>(p, { method: 'DELETE', body });

export function qs(params: Record<string, string | number | boolean | null | undefined | string[]>) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    u.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}
