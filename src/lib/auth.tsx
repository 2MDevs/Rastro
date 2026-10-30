import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { api, get, onApiSignal, post } from './api';
import { connectRealtime, disconnectRealtime } from './events';
import type { Capability, Me } from './types';

interface AuthState {
  status: 'loading' | 'anon' | 'ready';
  user: Me | null;
  locked: boolean;
  lockIdleMinutes: number;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  setLocked: (v: boolean) => void;
  can: (c: Capability) => boolean;
}

const Ctx = createContext<AuthState>(null as any);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const [user, setUser] = useState<Me | null>(null);
  const [locked, setLocked] = useState(false);
  const [lockIdleMinutes, setIdle] = useState(10);

  const refresh = useCallback(async () => {
    try {
      const r = await get<{ user: Me; sessionLocked: boolean }>('/api/auth/me');
      setUser(r.user);
      setLocked(r.sessionLocked);
      setStatus('ready');
      const p = await get<{ lockIdleMinutes: number }>('/api/auth/security-policy').catch(() => null);
      if (p) setIdle(p.lockIdleMinutes);
    } catch {
      setUser(null);
      setStatus('anon');
    }
  }, []);

  const logout = useCallback(async () => {
    await post('/api/auth/logout').catch(() => {});
    disconnectRealtime();
    setUser(null);
    setLocked(false);
    setStatus('anon');
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => onApiSignal((code) => {
    if (code === 'NO_SESSION') { disconnectRealtime(); setUser(null); setStatus('anon'); }
    if (code === 'SESSION_LOCKED') setLocked(true);
    if (code === 'MUST_CHANGE_PASSWORD') refresh();
  }), [refresh]);

  useEffect(() => {
    if (status === 'ready' && !locked && !user?.mustChangePassword) connectRealtime();
  }, [status, locked, user?.mustChangePassword]);

  // Bloqueio por inatividade
  const last = useRef(Date.now());
  useEffect(() => {
    if (status !== 'ready' || locked) return;
    const bump = () => { last.current = Date.now(); };
    const evs = ['mousemove', 'keydown', 'pointerdown', 'wheel', 'touchstart', 'scroll'];
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const t = setInterval(() => {
      // O modo campo mantém a tela ativa durante o rastreamento: não bloqueia no meio da operação
      if ((window as any).__rastroTrackingActive) { last.current = Date.now(); return; }
      if (Date.now() - last.current > lockIdleMinutes * 60_000) {
        api('/api/auth/lock', { method: 'POST', body: {} }).catch(() => {});
        setLocked(true);
      }
    }, 15_000);
    return () => { evs.forEach((e) => window.removeEventListener(e, bump)); clearInterval(t); };
  }, [status, locked, lockIdleMinutes]);

  const can = useCallback((c: Capability) => Boolean(user?.capabilities.includes(c)), [user]);

  return <Ctx.Provider value={{ status, user, locked, lockIdleMinutes, refresh, logout, setLocked, can }}>{children}</Ctx.Provider>;
}
