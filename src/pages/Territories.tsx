import { useEffect, useMemo, useState } from 'react';
import { Hexagon, Plus, Circle, PenLine, Archive, MapPin, Trash2, Check, RotateCcw } from 'lucide-react';
import { ApiError, del, get, patch, post, qs } from '../lib/api';
import { useLoad } from '../lib/useLoad';
import { area, distance } from '../lib/format';
import type { Area, LatLng, Poi } from '../lib/types';
import { StoreSelect, useStores } from '../components/filters';
import { MapView, MapFeature, ringToPolygon } from '../components/map/MapView';
import { useToast } from '../components/toast';
import { Badge, Button, Card, EmptyState, ErrorBox, Field, IconButton, Input, Notice, PageHeader, Select, Tabs, Textarea, useConfirm } from '../components/ui';

type Mode = null | { kind: 'new-radius' } | { kind: 'new-polygon' } | { kind: 'edit'; area: Area } | { kind: 'poi' };

export default function Territories() {
  const toast = useToast();
  const confirm = useConfirm();
  const { stores } = useStores();
  const [storeId, setStoreId] = useState('');
  const [tab, setTab] = useState<'areas' | 'pois'>('areas');
  const store = stores.find((s) => s.id === storeId);
  const areas = useLoad((s) => storeId ? get<Area[]>(`/api/territory/areas${qs({ storeId })}`, s) : Promise.resolve([]), [storeId]);
  const pois = useLoad((s) => storeId ? get<Poi[]>(`/api/territory/pois${qs({ storeId })}`, s) : Promise.resolve([]), [storeId]);

  const [mode, setMode] = useState<Mode>(null);
  const [name, setName] = useState('');
  const [radius, setRadius] = useState(1500);
  const [ring, setRing] = useState<[number, number][]>([]);
  const [drawKey, setDrawKey] = useState(0);
  const [poi, setPoi] = useState<{ name: string; category: string; notes: string; location: LatLng | null }>({ name: '', category: 'Condomínio', notes: '', location: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fitKey, setFitKey] = useState(0);

  useEffect(() => { setMode(null); setFitKey((k) => k + 1); }, [storeId]);
  useEffect(() => { setFitKey((k) => k + 1); }, [areas.data]);

  const startRadius = () => { setMode({ kind: 'new-radius' }); setName('Raio de alcance'); setRadius(1500); setError(null); };
  const startPolygon = () => { setMode({ kind: 'new-polygon' }); setName('Território desenhado'); setRing([]); setDrawKey((k) => k + 1); setError(null); };
  const startEdit = (a: Area) => { setMode({ kind: 'edit', area: a }); setName(a.name); setRadius(a.radiusM ?? 1500); setRing([]); setError(null); };

  // Pré-visualização do raio (o servidor calcula o polígono definitivo)
  const preview: MapFeature[] = useMemo(() => {
    const center = mode?.kind === 'edit' && mode.area.center ? mode.area.center : store?.location;
    if (!center || !(mode?.kind === 'new-radius' || (mode?.kind === 'edit' && mode.area.kind === 'RADIUS'))) return [];
    const steps = 72, k = Math.cos((center.lat * Math.PI) / 180);
    const coords = Array.from({ length: steps + 1 }, (_, i) => {
      const a = (i / steps) * 2 * Math.PI;
      return [center.lng + (Math.cos(a) * radius) / (111_320 * k), center.lat + (Math.sin(a) * radius) / 110_540];
    });
    return [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: { name, preview: true } }];
  }, [mode, radius, store?.location, name]);

  const areaFeatures: MapFeature[] = [
    ...(areas.data ?? []).filter((a) => !(mode?.kind === 'edit' && mode.area.id === a.id && a.kind === 'RADIUS')).map((a) => ({ type: 'Feature' as const, geometry: a.geometry, properties: { id: a.id, name: a.name, kind: a.kind, radiusM: a.radiusM, areaM2: a.areaM2 } })),
    ...preview,
  ];
  const poiFeatures: MapFeature[] = (pois.data ?? []).map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.location.lng, p.location.lat] }, properties: { id: p.id, name: p.name, category: p.category } }));

  async function save() {
    setBusy(true); setError(null);
    try {
      if (mode?.kind === 'new-radius') await post('/api/territory/areas', { storeId, name, kind: 'RADIUS', radiusM: radius });
      else if (mode?.kind === 'new-polygon') {
        const g = ringToPolygon(ring);
        if (!g) throw new ApiError(400, 'Clique pelo menos 3 pontos no mapa para formar o perímetro.');
        await post('/api/territory/areas', { storeId, name, kind: 'POLYGON', geometry: g });
      } else if (mode?.kind === 'edit') {
        const body: any = { name };
        if (mode.area.kind === 'RADIUS' && radius !== mode.area.radiusM) body.radiusM = radius;
        if (mode.area.kind === 'POLYGON' && ring.length >= 3) body.geometry = ringToPolygon(ring);
        await patch(`/api/territory/areas/${mode.area.id}`, body);
      }
      toast('ok', 'Território salvo.');
      setMode(null);
      areas.reload();
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.'); } finally { setBusy(false); }
  }

  async function archive(a: Area) {
    if (!(await confirm.ask('Arquivar território', <>Arquivar <strong>{a.name}</strong>? Ele deixa de aparecer no mapa e não pode ser escolhido em novas campanhas. As campanhas que já usam este território mantêm o histórico.</>, 'Arquivar', true))) return;
    try { await post(`/api/territory/areas/${a.id}/archive`); toast('ok', 'Território arquivado.'); areas.reload(); }
    catch (err) { toast('error', err instanceof ApiError ? err.message : 'Não foi possível arquivar.'); }
  }

  async function savePoi() {
    setBusy(true); setError(null);
    try {
      await post('/api/territory/pois', { storeId, name: poi.name, category: poi.category, notes: poi.notes || null, location: poi.location });
      toast('ok', 'Ponto de interesse salvo.');
      setMode(null); setPoi({ name: '', category: 'Condomínio', notes: '', location: null });
      pois.reload();
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.'); } finally { setBusy(false); }
  }

  async function removePoi(p: Poi) {
    if (!(await confirm.ask('Remover ponto', <>Remover <strong>{p.name}</strong>?</>, 'Remover', true))) return;
    try { await del(`/api/territory/pois/${p.id}`); pois.reload(); } catch (err) { toast('error', err instanceof ApiError ? err.message : 'Não foi possível remover.'); }
  }

  const drawing = mode?.kind === 'new-polygon' || (mode?.kind === 'edit' && (mode as any).redraw === true);
  const editing = mode !== null && mode.kind !== 'poi';

  return (
    <div>
      {confirm.element}
      <PageHeader title="Territórios" subtitle="Áreas de atuação de cada loja e pontos de interesse"
        actions={<StoreSelect value={storeId} onChange={setStoreId} allowAll={false} />} />
      {!stores.length ? (
        <Card><EmptyState icon={<Hexagon className="size-5" />} title="Nenhuma loja disponível">Cadastre uma loja em Unidades para definir territórios.</EmptyState></Card>
      ) : (
        <div className="grid lg:grid-cols-[1fr_380px] gap-5">
          <Card padded={false} className="overflow-hidden">
            <MapView key={storeId} className="h-[62dvh] min-h-[340px] sm:h-[560px]" stores={store ? [{ id: store.id, name: store.name, code: store.code, location: store.location }] : []}
              areas={areaFeatures} pois={poiFeatures} fitKey={fitKey}
              drawing={drawing} drawKey={drawKey} onDrawChange={setRing}
              picking={mode?.kind === 'poi'} onPick={(p) => setPoi((x) => ({ ...x, location: p }))} pickMarker={mode?.kind === 'poi' ? poi.location : null} />
            {drawing && (
              <div className="px-5 py-3 border-t border-line flex flex-wrap items-center gap-3 text-sm">
                <PenLine className="size-4 text-accent-ink" />
                <span className="text-ink-2 flex-1">Clique no mapa para marcar os cantos do perímetro ({ring.length} ponto{ring.length === 1 ? '' : 's'}). Não cruze as bordas.</span>
                <Button variant="ghost" icon={<RotateCcw className="size-4" />} onClick={() => { setRing([]); setDrawKey((k) => k + 1); }}>Recomeçar</Button>
              </div>
            )}
            {store && !store.location && <div className="px-5 py-3 border-t border-line"><Notice tone="warn">Esta loja ainda não tem localização. Defina em Unidades para criar território por raio.</Notice></div>}
          </Card>

          <div className="space-y-4">
            <Tabs value={tab} onChange={(v) => { setTab(v); setMode(null); }} items={[{ value: 'areas', label: 'Territórios' }, { value: 'pois', label: 'Pontos de interesse' }]} />
            {error && <ErrorBox>{error}</ErrorBox>}

            {tab === 'areas' && !editing && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <Button icon={<Circle className="size-4" />} onClick={startRadius} disabled={!store?.location}>Raio da loja</Button>
                  <Button icon={<PenLine className="size-4" />} onClick={startPolygon}>Desenhar perímetro</Button>
                </div>
                <p className="text-xs text-ink-3">O raio é uma aproximação. Para seguir ruas, avenidas e limites reais do bairro, prefira desenhar o perímetro.</p>
                <Card padded={false}>
                  {(areas.data ?? []).length ? (
                    <ul className="divide-y divide-line">
                      {areas.data!.map((a) => (
                        <li key={a.id} className="px-4 py-3 flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-ink truncate">{a.name}</div>
                            <div className="text-xs text-ink-3">{a.kind === 'RADIUS' ? `Raio de ${distance(a.radiusM)}` : 'Perímetro desenhado'} · {area(a.areaM2)}</div>
                          </div>
                          <Button variant="ghost" onClick={() => startEdit(a)}>Editar</Button>
                          <IconButton label="Arquivar" onClick={() => archive(a)}><Archive className="size-4" /></IconButton>
                        </li>
                      ))}
                    </ul>
                  ) : <EmptyState icon={<Hexagon className="size-5" />} title="Nenhum território">Crie um raio a partir da loja ou desenhe o perímetro da área de atuação.</EmptyState>}
                </Card>
              </>
            )}

            {tab === 'areas' && editing && (
              <Card title={mode?.kind === 'edit' ? 'Editar território' : mode?.kind === 'new-radius' ? 'Novo território por raio' : 'Novo perímetro'}>
                <div className="space-y-4">
                  <Field label="Nome"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
                  {(mode?.kind === 'new-radius' || (mode?.kind === 'edit' && mode.area.kind === 'RADIUS')) && (
                    <Field label={`Raio de alcance: ${distance(radius)}`}>
                      <input type="range" min={100} max={10000} step={50} value={radius} onChange={(e) => setRadius(Number(e.target.value))} className="w-full accent-[#F6D35C]" />
                      <div className="flex justify-between text-[11px] text-ink-3"><span>100 m</span><span>10 km</span></div>
                    </Field>
                  )}
                  {mode?.kind === 'edit' && mode.area.kind === 'POLYGON' && (
                    (mode as any).redraw
                      ? <p className="text-xs text-ink-3">Desenhe o novo perímetro no mapa ({ring.length} pontos). Ao salvar, ele substitui o anterior.</p>
                      : <Button icon={<PenLine className="size-4" />} onClick={() => { setRing([]); setDrawKey((k) => k + 1); setMode({ ...(mode as any), redraw: true }); }}>Redesenhar perímetro</Button>
                  )}
                  {mode?.kind === 'new-polygon' && <Badge tone={ring.length >= 3 ? 'ok' : 'warn'}>{ring.length >= 3 ? 'Perímetro pronto para salvar' : 'Marque pelo menos 3 pontos'}</Badge>}
                  <div className="flex gap-2 justify-end">
                    <Button variant="ghost" onClick={() => setMode(null)}>Cancelar</Button>
                    <Button variant="primary" icon={<Check className="size-4" />} loading={busy} onClick={save} disabled={!name || (mode?.kind === 'new-polygon' && ring.length < 3)}>Salvar</Button>
                  </div>
                </div>
              </Card>
            )}

            {tab === 'pois' && (
              <>
                {mode?.kind === 'poi' ? (
                  <Card title="Novo ponto de interesse">
                    <div className="space-y-3">
                      <Notice tone={poi.location ? 'ok' : 'info'}>{poi.location ? 'Local marcado. Você pode clicar de novo para ajustar.' : 'Clique no mapa para marcar o local.'}</Notice>
                      <Field label="Nome"><Input value={poi.name} onChange={(e) => setPoi({ ...poi, name: e.target.value })} maxLength={120} /></Field>
                      <Field label="Categoria">
                        <Select value={poi.category} onChange={(e) => setPoi({ ...poi, category: e.target.value })}>
                          {['Condomínio', 'Comércio', 'Escola', 'Ponto de apoio', 'Área de risco', 'Outro'].map((c) => <option key={c}>{c}</option>)}
                        </Select>
                      </Field>
                      <Field label="Observações"><Textarea value={poi.notes} onChange={(e) => setPoi({ ...poi, notes: e.target.value })} maxLength={500} /></Field>
                      <div className="flex gap-2 justify-end">
                        <Button variant="ghost" onClick={() => setMode(null)}>Cancelar</Button>
                        <Button variant="primary" loading={busy} onClick={savePoi} disabled={!poi.name || !poi.location}>Salvar</Button>
                      </div>
                    </div>
                  </Card>
                ) : <Button icon={<Plus className="size-4" />} onClick={() => { setMode({ kind: 'poi' }); setError(null); }}>Novo ponto de interesse</Button>}
                <Card padded={false}>
                  {(pois.data ?? []).length ? (
                    <ul className="divide-y divide-line">
                      {pois.data!.map((p) => (
                        <li key={p.id} className="px-4 py-3 flex items-center gap-3">
                          <MapPin className="size-4 text-[#B48CF2]" />
                          <div className="flex-1 min-w-0"><div className="text-sm text-ink truncate">{p.name}</div><div className="text-xs text-ink-3">{p.category}</div></div>
                          <IconButton label="Remover" onClick={() => removePoi(p)}><Trash2 className="size-4" /></IconButton>
                        </li>
                      ))}
                    </ul>
                  ) : <EmptyState icon={<MapPin className="size-5" />} title="Nenhum ponto de interesse">Marque condomínios, comércios ou pontos de apoio relevantes para a operação.</EmptyState>}
                </Card>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
