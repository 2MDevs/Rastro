import { useSyncExternalStore } from 'react';

/**
 * "Visão da loja": quando alguém da Matriz (Administrador, Diretor, Gestor) entra no painel de uma loja,
 * o RASTRO passa a mostrar só aquela loja — menu, mapa, campanhas, percursos e territórios —, como se
 * estivesse com o login da loja. O servidor também restringe as consultas a ela (cabeçalho X-Rastro-Loja).
 * Vale para esta aba do navegador; "Voltar ao Painel Matriz" sai da visão.
 */
export interface StoreView { id: string; name: string }

const KEY = 'rastro-visao-loja';
const subs = new Set<() => void>();

function read(): StoreView | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    return v && typeof v.id === 'string' ? v : null;
  } catch { return null; }
}
let current: StoreView | null = read();

export const getStoreView = () => current;

export function setStoreView(v: StoreView | null) {
  if (current?.id === v?.id && current?.name === v?.name) return;
  current = v;
  try { if (v) sessionStorage.setItem(KEY, JSON.stringify(v)); else sessionStorage.removeItem(KEY); } catch { /* sem armazenamento */ }
  subs.forEach((f) => f());
}

export function onStoreViewChange(fn: () => void) {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

export function useStoreView() {
  return useSyncExternalStore((cb) => onStoreViewChange(cb), getStoreView, getStoreView);
}
