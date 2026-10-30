import { ReactNode } from 'react';
import { Layers, Store, Circle, Route, MapPin, Radio } from 'lucide-react';
import { Toggle, cx } from '../ui';
import { LayerKey, MAP_COLORS } from './MapView';

export const LAYER_INFO: Record<LayerKey, { label: string; icon: ReactNode }> = {
  stores: { label: 'Unidade (loja)', icon: <Store className="size-4" /> },
  areas: { label: 'Área de cobertura', icon: <Circle className="size-4" /> },
  streets: { label: 'Ruas anunciadas', icon: <Route className="size-4" /> },
  routes: { label: 'Percursos realizados', icon: <Route className="size-4" /> },
  pois: { label: 'Pontos de interesse', icon: <MapPin className="size-4" /> },
  live: { label: 'Em campo agora', icon: <Radio className="size-4" /> },
};

export function LayerPanel({ visible, onChange, extra, counts }: {
  visible: Record<LayerKey, boolean>;
  onChange: (k: LayerKey, v: boolean) => void;
  extra?: Partial<Record<LayerKey, ReactNode>>;
  counts?: Partial<Record<LayerKey, number>>;
}) {
  return (
    <section className="rounded-2xl bg-panel border border-line">
      <header className="flex items-center gap-2 px-4 pt-4 pb-2 text-sm font-semibold text-ink">
        <Layers className="size-4 text-accent-ink" /> Camadas de exibição
      </header>
      <ul className="px-2 pb-2">
        {(Object.keys(LAYER_INFO) as LayerKey[]).map((k) => (
          <li key={k} className="rounded-xl px-2 py-2">
            <div className="flex items-center gap-3">
              <span className={cx('text-ink-3', visible[k] && 'text-accent-ink')}>{LAYER_INFO[k].icon}</span>
              <span className="flex-1 text-sm text-ink">{LAYER_INFO[k].label}</span>
              {counts?.[k] !== undefined && <span className="text-xs text-ink-3 tabular">{counts[k]}</span>}
              <Toggle checked={visible[k]} onChange={(v) => onChange(k, v)} label={`Mostrar ${LAYER_INFO[k].label}`} />
            </div>
            {visible[k] && extra?.[k] && <div className="mt-2 pl-7">{extra[k]}</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}

const Line = ({ color, dashed }: { color: string; dashed?: boolean }) => (
  <svg width="26" height="8" aria-hidden="true"><line x1="1" y1="4" x2="25" y2="4" stroke={color} strokeWidth="3" strokeLinecap="round" strokeDasharray={dashed ? '4 3' : undefined} /></svg>
);

/** Legenda que acompanha as camadas ligadas */
export function Legend({ visible, coverageKnown }: { visible: Record<LayerKey, boolean>; coverageKnown?: boolean }) {
  const items: { key: string; el: ReactNode; label: string }[] = [];
  if (visible.stores) items.push({ key: 's', label: 'Loja / unidade', el: <span className="size-3 rounded-full bg-amarelo border-2 border-grafite inline-block" /> });
  if (visible.areas) items.push({ key: 'a', label: 'Área de cobertura (alcance configurado)', el: <span className="inline-block w-6 h-3 rounded-sm border border-dashed" style={{ borderColor: MAP_COLORS.area, background: 'rgba(246,211,92,.15)' }} /> });
  if (visible.streets) {
    items.push({ key: 'r1', label: coverageKnown ? 'Rua anunciada — ainda não percorrida' : 'Rua anunciada (planejada)', el: <Line color={MAP_COLORS.streetPending} /> });
    if (coverageKnown) {
      items.push({ key: 'r2', label: 'Rua parcialmente percorrida', el: <Line color={MAP_COLORS.streetPartial} /> });
      items.push({ key: 'r3', label: 'Rua percorrida', el: <Line color={MAP_COLORS.streetDone} /> });
    }
  }
  if (visible.routes) items.push({ key: 'p', label: 'Percurso realizado (GPS)', el: <Line color={MAP_COLORS.route} /> });
  if (visible.pois) items.push({ key: 'i', label: 'Ponto de interesse', el: <span className="size-3 rounded-full inline-block border border-white" style={{ background: MAP_COLORS.poi }} /> });
  if (visible.live) items.push({ key: 'l', label: 'Posição atual em campo (cinza = sem comunicação)', el: <span className="size-3 rounded-full inline-block border-2 border-white" style={{ background: MAP_COLORS.live }} /> });
  if (!items.length) return null;
  return (
    <section className="rounded-2xl bg-panel border border-line px-4 py-3">
      <h3 className="text-xs font-semibold text-ink-2 mb-2">Legenda</h3>
      <ul className="space-y-1.5">
        {items.map((i) => (
          <li key={i.key} className="flex items-center gap-3 text-xs text-ink-2"><span className="w-7 flex justify-center">{i.el}</span>{i.label}</li>
        ))}
      </ul>
      <p className="text-[11px] text-ink-3 mt-3 leading-snug">O GPS mostra o deslocamento registrado pelo aparelho. Ele não comprova, sozinho, a entrega dos panfletos.</p>
    </section>
  );
}
