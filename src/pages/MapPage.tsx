import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { X, Store as StoreIcon, Route as RouteIcon, Clock, Target, SlidersHorizontal, ChevronRight, MapPin } from 'lucide-react';
import { get, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLoad } from '../lib/useLoad';
import { useRealtime } from '../lib/events';
import { area, dateTime, distance, duration, pct, relative } from '../lib/format';
import type { Area, Campaign, Poi, SessionInfo } from '../lib/types';
import { MapView, MapFeature, LayerKey, Selection } from '../components/map/MapView';
import { LayerPanel, Legend } from '../components/map/LayerPanel';
import { useStores, PeriodFilter, defaultPeriod } from '../components/filters';
import { Badge, Button, Checkbox, IconButton, Select, cx } from '../components/ui';

const STORAGE_KEY = 'rastro-camadas';
function initialLayers(): Record<LayerKey, boolean> {
  const base = { stores: true, areas: true, streets: true, routes: true, pois: false, live: true };
  try { return { ...base, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') }; } catch { return base; }
}

export default function MapPage() {
  const { user, can } = useAuth();
  const matrix = user?.stores === 'ALL';
  const { stores } = useStores();
  const [params] = useSearchParams();
  const [selectedStores, setSelectedStores] = useState<string[]>(() => (params.get('loja') ? [params.get('loja')!] : []));
  const [campaignId, setCampaignId] = useState('');
  const [period, setPeriod] = useState(defaultPeriod());
  const [layers, setLayers] = useState(initialLayers);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [fitKey, setFitKey] = useState(0);

  // Loja: já começa com as próprias lojas. Matriz: escolhe quais lojas detalhar (evita mostrar tudo de uma vez).
  useEffect(() => {
    if (!matrix && stores.length && !selectedStores.length) setSelectedStores(stores.map((s) => s.id));
  }, [matrix, stores]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(layers)); } catch { /* ok */ } }, [layers]);

  const storeKey = selectedStores.join(',');
  const has = selectedStores.length > 0;
  const areas = useLoad((s) => has ? get<Area[]>(`/api/territory/areas`, s) : Promise.resolve([]), [storeKey]);
  const pois = useLoad((s) => has ? get<Poi[]>(`/api/territory/pois`, s) : Promise.resolve([]), [storeKey]);
  const campaigns = useLoad((s) => has ? get<Campaign[]>(`/api/campaigns${qs({ storeId: selectedStores.length === 1 ? selectedStores[0] : undefined })}`, s) : Promise.resolve([]), [storeKey]);
  const streets = useLoad((s) => has ? get(`/api/campaigns/map/streets${qs({ storeIds: selectedStores, campaignId })}`, s) : Promise.resolve({ features: [] }), [storeKey, campaignId]);
  const routes = useLoad((s) => has && can('tracking.view') ? get(`/api/tracking/routes${qs({ storeIds: selectedStores, campaignId, from: period.from, to: period.to })}`, s) : Promise.resolve({ features: [] }), [storeKey, campaignId, period.from, period.to]);
  const live = useLoad((s) => get<SessionInfo[]>(`/api/tracking/live`, s), []);
  const dash = useLoad((s) => selectedStores.length === 1 ? get(`/api/reports/dashboard${qs({ storeId: selectedStores[0], from: period.from, to: period.to })}`, s) : Promise.resolve(null), [storeKey, period.from, period.to]);

  useRealtime('tracking', (ev) => {
    live.reload(true);
    if (ev?.type === 'session') routes.reload(true);
  }, [storeKey, campaignId, period.from, period.to]);
  useRealtime('data', (ev) => {
    if (ev?.kind === 'areas') areas.reload(true);
    if (ev?.kind === 'pois') pois.reload(true);
    if (['streets', 'coverage', 'campaigns'].includes(ev?.kind)) { streets.reload(true); campaigns.reload(true); }
  }, [storeKey, campaignId]);

  const sel = new Set(selectedStores);
  const areaFeatures: MapFeature[] = useMemo(() => (areas.data ?? []).filter((a) => sel.has(a.storeId)).map((a) => ({
    type: 'Feature', geometry: a.geometry, properties: { id: a.id, name: a.name, storeId: a.storeId, kind: a.kind, radiusM: a.radiusM, areaM2: a.areaM2 },
  })), [areas.data, storeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const poiFeatures: MapFeature[] = useMemo(() => (pois.data ?? []).filter((p) => sel.has(p.storeId)).map((p) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [p.location.lng, p.location.lat] }, properties: { id: p.id, name: p.name, category: p.category, notes: p.notes },
  })), [pois.data, storeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const liveFeatures: MapFeature[] = useMemo(() => (live.data ?? []).filter((s) => s.lastPosition && (!has || sel.has(s.storeId)) && (!campaignId || s.campaignId === campaignId)).map((s) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [s.lastPosition!.lng, s.lastPosition!.lat] },
    properties: { sessionId: s.id, userName: s.userName, campaignName: s.campaignName, storeName: s.storeName, accuracyM: s.lastPosition!.accuracyM, stale: s.state === 'NO_COMMUNICATION', lastAt: s.lastPointReceivedAt },
  })), [live.data, storeKey, campaignId]); // eslint-disable-line react-hooks/exhaustive-deps

  const mapStores = stores.map((s) => ({ id: s.id, name: s.name, code: s.code, location: s.location, selected: sel.has(s.id) }));
  const coverageKnown = (streets.data?.features ?? []).some((f: any) => f.properties.status);
  const single = selectedStores.length === 1 ? stores.find((s) => s.id === selectedStores[0]) : null;
  const singleDash = dash.data?.stores?.[0];
  const singleArea = single ? (areas.data ?? []).find((a) => a.storeId === single.id) : null;

  useEffect(() => { setFitKey((k) => k + 1); }, [storeKey, stores.length, areas.data, streets.data]); // reenquadra quando muda o recorte

  const toggleStore = (id: string) => setSelectedStores((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));

  return (
    <div className="relative h-full flex">
      <div className="relative flex-1 min-w-0">
        <MapView className="absolute inset-0" stores={mapStores} areas={areaFeatures} streets={streets.data?.features ?? []} routes={routes.data?.features ?? []}
          pois={poiFeatures} live={liveFeatures} visible={layers} onSelect={(s) => { setSelection(s); if (s?.kind === 'store' && matrix && !sel.has(s.props.id)) toggleStore(s.props.id); }} fitKey={fitKey} />

        {/* Faixa da loja selecionada (como na referência aprovada) */}
        {single && (
          <div className="absolute top-3 left-3 right-14 z-10 hidden md:flex items-center gap-5 rounded-2xl border border-line bg-panel/95 px-4 py-3">
            <div className="flex items-center gap-3 min-w-0">
              <StoreIcon className="size-5 text-accent-ink shrink-0" />
              <div className="min-w-0">
                <div className="flex items-center gap-2"><span className="font-semibold text-ink truncate">{single.name}</span>
                  <Badge tone={single.operating ? 'ok' : 'neutral'}>{single.operating ? 'Em operação' : 'Sem campanha ativa'}</Badge></div>
                <div className="text-xs text-ink-3 truncate">{single.address || 'Endereço: A definir'}</div>
              </div>
            </div>
            <div className="h-9 w-px bg-line" />
            <Mini icon={<Target className="size-4" />} label="Área de cobertura" value={singleArea ? (singleArea.kind === 'RADIUS' ? `raio ${distance(singleArea.radiusM)}` : area(singleArea.areaM2)) : 'Não definida'} />
            <Mini icon={<RouteIcon className="size-4" />} label="Percurso realizado" value={singleDash ? distance(singleDash.distanceM) : '—'}
              extra={singleDash?.coveragePercent !== null && singleDash?.coveragePercent !== undefined ? `cobertura ${pct(singleDash.coveragePercent)}` : undefined} />
            <Mini icon={<Clock className="size-4" />} label="Tempo em campo" value={singleDash ? duration(singleDash.fieldSeconds) : '—'} />
          </div>
        )}

        {matrix && !has && (
          <div className="absolute top-3 left-3 z-10 max-w-sm rounded-2xl border border-line bg-panel/95 px-4 py-3 text-sm text-ink-2">
            Selecione uma ou mais lojas (no painel ou clicando no marcador) para ver territórios, ruas anunciadas e percursos.
          </div>
        )}

        {!panelOpen && (
          <Button className="absolute bottom-8 right-3 z-10 lg:hidden" icon={<SlidersHorizontal className="size-4" />} onClick={() => setPanelOpen(true)}>Camadas</Button>
        )}
        {selection && <DetailPanel selection={selection} onClose={() => setSelection(null)} stores={stores} campaigns={campaigns.data ?? []} />}
      </div>

      {/* Painel lateral */}
      <aside className={cx('w-full sm:w-[340px] shrink-0 border-l border-line bg-bg overflow-y-auto scroll-thin p-3 space-y-3',
        'absolute inset-y-0 right-0 z-20 lg:static', panelOpen ? 'block' : 'hidden lg:block')}>
        <div className="flex items-center justify-between lg:hidden">
          <span className="text-sm font-semibold">Mapa</span>
          <IconButton label="Fechar painel" onClick={() => setPanelOpen(false)}><X className="size-5" /></IconButton>
        </div>
        <LayerPanel visible={layers} onChange={(k, v) => setLayers((l) => ({ ...l, [k]: v }))}
          counts={{ stores: mapStores.filter((s) => s.location).length, areas: areaFeatures.length, streets: streets.data?.features?.length ?? 0, routes: routes.data?.features?.length ?? 0, pois: poiFeatures.length, live: liveFeatures.length }}
          extra={{
            areas: single && singleArea?.kind === 'RADIUS' && can('territory.manage')
              ? <Link to="/territorios" className="text-xs text-accent-ink underline">Ajustar o raio de alcance em Territórios</Link> : undefined,
            routes: !can('tracking.view') ? <span className="text-xs text-ink-3">Seu perfil não visualiza percursos de outras pessoas.</span> : undefined,
          }} />

        <section className="rounded-2xl bg-panel border border-line p-4 space-y-3">
          <h3 className="text-sm font-semibold text-ink">Filtros</h3>
          {matrix && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-medium text-ink-2">Lojas detalhadas</span>
                <span className="flex gap-2 text-xs">
                  <button className="text-accent-ink" onClick={() => setSelectedStores(stores.map((s) => s.id))}>todas</button>
                  <button className="text-ink-3" onClick={() => setSelectedStores([])}>nenhuma</button>
                </span>
              </div>
              <div className="max-h-44 overflow-y-auto scroll-thin space-y-1.5 pr-1">
                {stores.map((s) => <Checkbox key={s.id} checked={sel.has(s.id)} onChange={() => toggleStore(s.id)} label={`${s.name} (${s.code})`} />)}
                {!stores.length && <p className="text-xs text-ink-3">Nenhuma loja cadastrada.</p>}
              </div>
            </div>
          )}
          <label className="block">
            <span className="block text-xs font-medium text-ink-2 mb-1.5">Campanha</span>
            <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} disabled={!has}>
              <option value="">Ativas, pausadas e planejadas</option>
              {(campaigns.data ?? []).filter((c) => sel.has(c.storeId)).map((c) => <option key={c.id} value={c.id}>{c.name} · {c.statusLabel}</option>)}
            </Select>
          </label>
          <div>
            <span className="block text-xs font-medium text-ink-2 mb-1.5">Período dos percursos</span>
            <PeriodFilter value={period} onChange={setPeriod} />
          </div>
          {routes.data?.truncated && <p className="text-xs text-warn">Mostrando os 200 percursos mais recentes. Reduza o período para ver todos.</p>}
        </section>

        <Legend visible={layers} coverageKnown={coverageKnown} />
      </aside>
    </div>
  );
}

function Mini({ icon, label, value, extra }: { icon: React.ReactNode; label: string; value: string; extra?: string }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-accent-ink">{icon}</span>
      <div className="min-w-0">
        <div className="text-[11px] text-ink-3">{label}</div>
        <div className="text-sm font-semibold text-ink tabular truncate">{value}{extra && <span className="ml-2 text-xs font-normal text-ink-3">{extra}</span>}</div>
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = { DONE: 'Percorrida', PARTIAL: 'Parcialmente percorrida', PENDING: 'Ainda não percorrida' };

/** Painel de detalhes contextual (um de cada vez, sem janelas sobrepostas) */
function DetailPanel({ selection, onClose, stores, campaigns }: { selection: Selection; onClose: () => void; stores: any[]; campaigns: Campaign[] }) {
  const p = selection.props;
  let title = '', body: React.ReactNode = null, link: { to: string; label: string } | null = null;
  switch (selection.kind) {
    case 'store': {
      const s = stores.find((x) => x.id === p.id);
      title = s?.name ?? 'Loja';
      body = s && <>
        <Row k="Código" v={s.code} />
        <Row k="Endereço" v={s.address || 'A definir'} />
        <Row k="Situação" v={s.operating ? `Em operação (${s.activeCampaigns} campanha(s) ativa(s))` : 'Sem campanha ativa'} />
        <Row k="Em campo agora" v={String(s.liveSessions)} />
        <Row k="Última atividade" v={s.lastActivityAt ? relative(s.lastActivityAt) : '—'} />
      </>;
      link = { to: '/unidades', label: 'Ver unidade' };
      break;
    }
    case 'area':
      title = p.name;
      body = <>
        <Row k="Tipo" v={p.kind === 'RADIUS' ? `Raio de ${distance(p.radiusM)}` : 'Perímetro desenhado'} />
        <Row k="Área" v={area(p.areaM2)} />
        <p className="text-xs text-ink-3 mt-2">Alcance configurado. Não representa, por si só, a cobertura realizada.</p>
      </>;
      link = { to: '/territorios', label: 'Abrir territórios' };
      break;
    case 'street':
      title = p.name;
      body = <>
        <Row k="Tipo de via" v={p.highway} />
        <Row k="Comprimento planejado" v={distance(p.lengthM)} />
        <Row k="Campanha" v={p.campaignName} />
        <Row k="Situação" v={p.status ? `${STATUS_LABEL[p.status]} (${pct(p.coveredPct)})` : 'Cobertura ainda não calculada'} />
      </>;
      link = { to: `/campanhas/${p.campaignId}`, label: 'Abrir campanha' };
      break;
    case 'route':
      title = `Percurso de ${p.userName}`;
      body = <>
        <Row k="Campanha" v={p.campaignName} />
        <Row k="Loja" v={p.storeName} />
        <Row k="Início" v={dateTime(p.startedAt)} />
        <Row k="Fim" v={p.finishedAt ? dateTime(p.finishedAt) : 'Em andamento'} />
        <Row k="Distância válida" v={distance(p.distanceM)} />
      </>;
      link = { to: `/percursos/${p.sessionId}`, label: 'Ver percurso completo' };
      break;
    case 'poi':
      title = p.name;
      body = <><Row k="Categoria" v={p.category} />{p.notes && <Row k="Observações" v={p.notes} />}</>;
      break;
    case 'live':
      title = p.userName;
      body = <>
        <Row k="Campanha" v={p.campaignName} />
        <Row k="Loja" v={p.storeName} />
        <Row k="Último ponto" v={relative(p.lastAt)} />
        <Row k="Precisão" v={p.accuracyM ? `± ${Math.round(p.accuracyM)} m` : 'não informada'} />
        {p.stale && <p className="text-xs text-warn mt-2">Sem comunicação recente: a posição pode estar desatualizada.</p>}
      </>;
      link = { to: `/percursos/${p.sessionId}`, label: 'Acompanhar percurso' };
      break;
    default:
      return null;
  }
  void campaigns;
  return (
    <div className="absolute z-20 left-3 right-3 bottom-3 sm:left-auto sm:right-3 sm:top-24 sm:bottom-auto sm:w-80 rounded-2xl border border-line bg-panel shadow-2xl">
      <header className="flex items-center gap-2 px-4 pt-3">
        <MapPin className="size-4 text-accent-ink" />
        <h3 className="flex-1 font-semibold text-ink truncate">{title}</h3>
        <IconButton label="Fechar detalhes" onClick={onClose}><X className="size-4" /></IconButton>
      </header>
      <div className="px-4 pb-3 text-sm">{body}</div>
      {link && <Link to={link.to} className="flex items-center justify-between border-t border-line px-4 py-2.5 text-sm text-accent-ink hover:bg-panel-2 rounded-b-2xl">{link.label}<ChevronRight className="size-4" /></Link>}
    </div>
  );
}

const Row = ({ k, v }: { k: string; v: string }) => (
  <div className="flex justify-between gap-3 py-1 border-b border-line last:border-0"><span className="text-ink-3">{k}</span><span className="text-ink text-right">{v}</span></div>
);
