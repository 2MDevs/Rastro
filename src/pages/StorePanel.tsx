import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, MapPin, Crosshair, Users as UsersIcon, UserPlus, Link2, X, Megaphone, Route as RouteIcon, Clock, Target, Radio, Smartphone, Share2 } from 'lucide-react';
import { shareApp } from '../lib/nativeApp';
import { ApiError, del, get, post, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLoad } from '../lib/useLoad';
import { useRealtime } from '../lib/events';
import { dateTime, distance, duration, pct, relative } from '../lib/format';
import type { Area, SessionInfo, Store } from '../lib/types';
import { MapView, MapFeature, MAP_COLORS } from '../components/map/MapView';
import { StoreLocationCapture } from '../components/StoreLocationCapture';
import { invalidateStores, defaultPeriod } from '../components/filters';
import { useToast } from '../components/toast';
import { Badge, Button, Card, EmptyState, ErrorBox, Notice, PageHeader, Select, Spinner, Stat, useConfirm } from '../components/ui';
import { UserForm } from './Users';

export default function StorePanel() {
  const { id } = useParams();
  const { user, can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const matrix = user?.stores === 'ALL';
  const [capturing, setCapturing] = useState(false);
  const [period] = useState(defaultPeriod());
  const store = useLoad((s) => get<Store>(`/api/stores/${id}`, s), [id]);
  const areas = useLoad((s) => get<Area[]>(`/api/territory/areas${qs({ storeId: id })}`, s), [id]);
  const dash = useLoad((s) => get(`/api/reports/dashboard${qs({ storeId: id, from: period.from, to: period.to })}`, s), [id]);
  const people = useLoad((s) => can('users.manage') ? get(`/api/stores/${id}/users`, s) : Promise.resolve(null), [id]);
  const roles = useLoad((s) => can('users.manage') ? get('/api/users', s).then((r) => r.assignableRoles) : Promise.resolve([]), []);
  const [linkId, setLinkId] = useState('');
  const [creating, setCreating] = useState(false);
  useRealtime('data', (ev) => { if (ev?.storeId === id) { store.reload(true); dash.reload(true); } }, [id]);

  // Percursos da loja (linha roxa) e quem está em campo agora, atualizando ao vivo
  const routes = useLoad((sig) => can('tracking.view') ? get(`/api/tracking/routes${qs({ storeIds: [id], from: period.from, to: period.to })}`, sig) : Promise.resolve({ features: [] }), [id]);
  const live = useLoad((sig) => get<SessionInfo[]>(`/api/tracking/live`, sig), [id]);
  const lastReload = useRef(0);
  const timer = useRef<number | null>(null);
  useRealtime('tracking', (ev) => {
    live.reload(true);
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null; lastReload.current = Date.now();
      routes.reload(true); if (ev?.type === 'session') dash.reload(true);
    }, Math.max(0, 8000 - (Date.now() - lastReload.current)));
  }, [id]);
  const liveHere = (live.data ?? []).filter((x) => x.storeId === id && x.lastPosition);
  useEffect(() => {
    if (!liveHere.length) return;
    const t = setInterval(() => { live.reload(true); routes.reload(true); }, 20_000);
    return () => { clearInterval(t); if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; } };
  }, [liveHere.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  const liveFeatures: MapFeature[] = useMemo(() => liveHere.map((x) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [x.lastPosition!.lng, x.lastPosition!.lat] },
    properties: { sessionId: x.id, userName: x.userName, campaignName: x.campaignName, storeName: x.storeName, accuracyM: x.lastPosition!.accuracyM, stale: x.state === 'NO_COMMUNICATION', lastAt: x.lastPointReceivedAt },
  })), [live.data, id]); // eslint-disable-line react-hooks/exhaustive-deps
  const routeFeatures: MapFeature[] = (routes.data as any)?.features ?? [];

  if (store.error) return <ErrorBox onRetry={() => store.reload()}>{store.error}</ErrorBox>;
  const s = store.data;
  if (!s) return <Spinner />;
  const d = dash.data?.stores?.[0];
  const info = s.locationInfo;
  const areaFeatures: MapFeature[] = (areas.data ?? []).map((a) => ({ type: 'Feature', geometry: a.geometry, properties: { id: a.id, name: a.name, kind: a.kind, radiusM: a.radiusM, areaM2: a.areaM2 } }));

  async function link() {
    if (!linkId) return;
    try { await post(`/api/stores/${id}/users`, { userId: linkId }); setLinkId(''); toast('ok', 'Pessoa vinculada à loja.'); people.reload(true); }
    catch (err) { toast('error', err instanceof ApiError ? err.message : 'Não foi possível vincular.'); }
  }
  async function unlink(p: any) {
    if (!(await confirm.ask('Desvincular pessoa', <>Retirar <strong>{p.name}</strong> desta loja? Ela deixa de ver os dados da loja na hora.</>, 'Desvincular', true))) return;
    try { await del(`/api/stores/${id}/users/${p.id}`); toast('ok', 'Pessoa desvinculada.'); people.reload(true); }
    catch (err) { toast('error', err instanceof ApiError ? err.message : 'Não foi possível desvincular.'); }
  }

  return (
    <div>
      {confirm.element}
      {matrix && <Link to="/unidades" className="inline-flex items-center gap-1 text-sm text-ink-3 hover:text-ink mb-3"><ArrowLeft className="size-4" /> Unidades</Link>}
      <PageHeader title={s.name}
        subtitle={<span className="inline-flex flex-wrap items-center gap-2">Painel da loja · código {s.code}
          {s.status === 'INACTIVE' ? <Badge>Inativa</Badge> : s.operating ? <Badge tone="ok">Em operação</Badge> : <Badge>Sem campanha ativa</Badge>}</span>}
        actions={<>
          <Link to={`/mapa?loja=${s.id}`}><Button icon={<MapPin className="size-4" />}>Abrir no mapa</Button></Link>
          <Link to={`/campanhas?loja=${s.id}`}><Button icon={<Megaphone className="size-4" />}>Campanhas</Button></Link>
        </>} />

      {!s.location && (
        <div className="mb-5">
          <Notice tone="warn" icon={<Crosshair className="size-4" />}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span><strong className="text-ink">Esta loja ainda não está no mapa.</strong> Registre a localização usando o celular, de dentro da loja.</span>
              {can('stores.locate') && <Button variant="primary" icon={<Crosshair className="size-4" />} onClick={() => setCapturing(true)}>Registrar localização</Button>}
            </div>
          </Notice>
        </div>
      )}

      <div className="grid xl:grid-cols-[1fr_380px] gap-5">
        <div className="space-y-5">
          <Card padded={false} className="overflow-hidden">
            <MapView className="h-[420px]" stores={s.location ? [{ id: s.id, name: s.name, code: s.code, location: s.location, selected: true }] : []}
              areas={areaFeatures} routes={routeFeatures} live={liveFeatures}
              fitKey={`${s.id}-${s.location?.lat}-${areaFeatures.length}-${routeFeatures.length > 0}`} visible={{ streets: false, pois: false }} />
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-4 py-2.5 border-t border-line text-xs text-ink-3">
              <span className="inline-flex items-center gap-2"><span className="inline-block h-1.5 w-6 rounded-full" style={{ background: MAP_COLORS.route }} />Percursos dos divulgadores (últimos 30 dias): {routeFeatures.length}</span>
              <span className="inline-flex items-center gap-2"><span className="inline-block size-2.5 rounded-full" style={{ background: MAP_COLORS.live }} />Em campo agora: {liveFeatures.length}</span>
              {!can('tracking.view') && <span>Seu perfil não visualiza percursos de outras pessoas.</span>}
            </div>
          </Card>
          <Card padded={false}>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-5 p-5">
              <Stat icon={<Megaphone className="size-4" />} label="Campanhas ativas" value={s.activeCampaigns} />
              <Stat icon={<Radio className="size-4" />} label="Em campo agora" value={s.liveSessions} />
              <Stat icon={<RouteIcon className="size-4" />} label="Percorrido (30 dias)" value={d ? distance(d.distanceM) : '—'} hint={d ? `${d.sessions} percurso(s)` : undefined} />
              <Stat icon={<Target className="size-4" />} label="Cobertura estimada" value={d?.coveragePercent === null || d?.coveragePercent === undefined ? 'Sem cálculo' : pct(d.coveragePercent)}
                hint={d ? <span className="inline-flex items-center gap-1"><Clock className="size-3" /> {duration(d.fieldSeconds)} em campo</span> : undefined} />
            </div>
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Localização da loja" actions={can('stores.locate') && s.location && <Button variant="ghost" icon={<Crosshair className="size-4" />} onClick={() => setCapturing(true)}>Registrar de novo</Button>}>
            {s.location && info ? (
              <dl className="text-sm space-y-2">
                <div className="flex justify-between gap-2"><dt className="text-ink-3">Origem</dt><dd className="text-ink text-right">{info.source === 'GPS' ? <Badge tone="ok">GPS dentro da loja</Badge> : <Badge tone="warn">Marcada no mapa</Badge>}</dd></div>
                {info.accuracyM !== null && <div className="flex justify-between gap-2"><dt className="text-ink-3">Precisão</dt><dd className="text-ink">± {info.accuracyM} m</dd></div>}
                <div className="flex justify-between gap-2"><dt className="text-ink-3">Registrada por</dt><dd className="text-ink text-right">{info.setByName ?? '—'}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-ink-3">Em</dt><dd className="text-ink">{dateTime(info.setAt)}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-ink-3">Coordenadas</dt><dd className="text-ink tabular text-xs">{s.location.lat.toFixed(6)}, {s.location.lng.toFixed(6)}</dd></div>
                {info.source !== 'GPS' && <p className="text-xs text-ink-3 pt-1">Para mais precisão, registre de novo usando o GPS do celular dentro da loja.</p>}
              </dl>
            ) : <p className="text-sm text-ink-3">Ainda não registrada.</p>}
            {s.address && <p className="text-xs text-ink-3 mt-3">Endereço: {s.address}</p>}
          </Card>

          {can('users.manage') && (
            <Card title={<span className="flex items-center gap-2"><UsersIcon className="size-4 text-accent-ink" /> Pessoas da loja</span>} padded={false}
              actions={<Button variant="ghost" icon={<UserPlus className="size-4" />} onClick={() => setCreating(true)}>Nova pessoa</Button>}>
              {!people.data ? <Spinner /> : (
                <>
                  {people.data.linked.length ? (
                    <ul className="divide-y divide-line">
                      {people.data.linked.map((p: any) => (
                        <li key={p.id} className="px-5 py-3 flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-ink truncate">{p.name}</div>
                            <div className="text-xs text-ink-3">{p.roleLabel} · {p.status === 'BLOCKED' ? 'bloqueado' : !p.hasPassword ? 'aguardando criar senha' : p.lastLoginAt ? `último acesso ${relative(p.lastLoginAt)}` : 'nunca entrou'}</div>
                          </div>
                          {p.role === 'PROMOTER' && p.status === 'ACTIVE' && (
                            <Button variant="ghost" icon={<Smartphone className="size-4" />} title="Enviar o link do app Android" onClick={() => shareApp(p.name)}>Enviar app</Button>
                          )}
                          <button aria-label={`Desvincular ${p.name}`} className="text-ink-3 hover:text-danger" onClick={() => unlink(p)}><X className="size-4" /></button>
                        </li>
                      ))}
                    </ul>
                  ) : <EmptyState icon={<UsersIcon className="size-5" />} title="Ninguém vinculado">Cadastre o gerente e os divulgadores desta loja.</EmptyState>}
                  <div className="flex items-center gap-3 px-5 py-3 border-t border-line bg-panel-2/50">
                    <Smartphone className="size-4 text-accent-ink shrink-0" />
                    <div className="flex-1 text-xs text-ink-3">Os divulgadores registram o percurso pelo <strong className="text-ink-2">app Android do RASTRO</strong>, que funciona com a tela apagada.</div>
                    <Button variant="ghost" icon={<Share2 className="size-4" />} onClick={() => shareApp()}>Compartilhar app</Button>
                  </div>
                  {people.data.available.length > 0 && (
                    <div className="flex gap-2 p-4 border-t border-line">
                      <Select value={linkId} onChange={(e) => setLinkId(e.target.value)}>
                        <option value="">Vincular pessoa já cadastrada...</option>
                        {people.data.available.map((p: any) => <option key={p.id} value={p.id}>{p.name} · {p.roleLabel}</option>)}
                      </Select>
                      <Button icon={<Link2 className="size-4" />} disabled={!linkId} onClick={link}>Vincular</Button>
                    </div>
                  )}
                </>
              )}
            </Card>
          )}
        </div>
      </div>

      {capturing && <StoreLocationCapture store={s} open={capturing} onClose={() => setCapturing(false)} onSaved={(n) => { store.setData(n); invalidateStores(); }} />}
      {creating && roles.data && (
        <UserForm user={null} roles={roles.data.filter((r: any) => ['STORE_MANAGER', 'PROMOTER'].includes(r.value))} defaultStoreIds={[s.id]}
          onClose={() => setCreating(false)} onSaved={() => { setCreating(false); people.reload(true); }} />
      )}
    </div>
  );
}
