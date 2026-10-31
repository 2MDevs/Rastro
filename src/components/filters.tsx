import { useEffect, useState } from 'react';
import { get } from '../lib/api';
import { daysAgo, today } from '../lib/format';
import type { Store } from '../lib/types';
import { Input, Select } from './ui';

let storeCache: { at: number; list: Store[] } | null = null;
export function useStores() {
  const [stores, setStores] = useState<Store[]>(storeCache?.list ?? []);
  const [loading, setLoading] = useState(!storeCache);
  useEffect(() => {
    if (storeCache && Date.now() - storeCache.at < 15_000) return;
    get<Store[]>('/api/stores').then((l) => { storeCache = { at: Date.now(), list: l }; setStores(l); }).catch(() => {}).finally(() => setLoading(false));
  }, []);
  const reload = () => get<Store[]>('/api/stores').then((l) => { storeCache = { at: Date.now(), list: l }; setStores(l); });
  return { stores, loading, reload };
}
export const invalidateStores = () => { storeCache = null; };

export function StoreSelect({ value, onChange, allLabel = 'Todas as lojas', allowAll = true, className }: { value: string; onChange: (v: string) => void; allLabel?: string; allowAll?: boolean; className?: string }) {
  const { stores } = useStores();
  useEffect(() => {
    if (!allowAll && !value && stores[0]) onChange(stores[0].id);
  }, [allowAll, value, stores]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className={className ?? 'w-auto min-w-48'} aria-label="Loja">
      {allowAll && <option value="">{allLabel}</option>}
      {!allowAll && !stores.length && <option value="">Nenhuma loja</option>}
      {stores.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
    </Select>
  );
}

export interface Period { from: string; to: string }
export const defaultPeriod = (): Period => ({ from: daysAgo(29), to: today() });

export function PeriodFilter({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const preset = (d: number) => onChange({ from: daysAgo(d - 1), to: today() });
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 w-full sm:w-auto sm:flex sm:flex-wrap">
      <Input type="date" value={value.from} max={value.to || undefined} onChange={(e) => onChange({ ...value, from: e.target.value })} className="sm:w-auto min-w-0" aria-label="Data inicial" />
      <span className="text-ink-3 text-sm">até</span>
      <Input type="date" value={value.to} min={value.from || undefined} onChange={(e) => onChange({ ...value, to: e.target.value })} className="sm:w-auto min-w-0" aria-label="Data final" />
      <div className="col-span-3 grid grid-cols-3 gap-1 sm:flex">
        {[7, 30, 90].map((d) => (
          <button key={d} onClick={() => preset(d)} className="h-9 sm:h-10 px-3 rounded-xl text-xs text-ink-2 border border-line hover:border-ink-3">{d} dias</button>
        ))}
      </div>
    </div>
  );
}
