import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Store as StoreIcon, Megaphone, Radio, Route as RouteIcon, Target, Clock, MapPinned, Download } from 'lucide-react';
import { get, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLoad } from '../lib/useLoad';
import { useRealtime } from '../lib/events';
import { distance, duration, num, pct, relative } from '../lib/format';
import { Badge, Button, Card, EmptyState, ErrorBox, PageHeader, Spinner, Stat, Table, Td } from '../components/ui';
import { PeriodFilter, StoreSelect, defaultPeriod } from '../components/filters';
import { MapView, MapFeature } from '../components/map/MapView';
import type { SessionInfo } from '../lib/types';

export default function Dashboard() {
  const { user, can } = useAuth();
  const navigate = useNavigate();
  const matrix = can('matrix.view');
  const [storeId, setStoreId] = useState('');
  const [period, setPeriod] = useState(defaultPeriod());
  const params = qs({ storeId, from: period.from, to: period.to });
  const dash = useLoad((s) => get(`/api/reports/dashboard${params}`, s), [params]);
  const live = useLoad((s) => get<SessionInfo[]>(`/api/tracking/live${qs({ storeId })}`, s), [storeId]);
  useRealtime('tracking', () => live.reload(true), []);
  useRealtime('data', () => dash.reload(true), [params]);

  const d = dash.data;
  const liveFeatures: MapFeature[] = useMemo(() => (live.data ?? []).filter((s) => s.lastPosition).map((s) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [s.lastPosition!.lng, s.lastPosition!.lat] },
    properties: { sessionId: s.id, userName: s.userName, campaignName: s.campaignName, accuracyM: s.lastPosition!.accuracyM, stale: s.state === 'NO_COMMUNICATION' },
  })), [live.data]);
  const storesForMap = (d?.stores ?? []).map((s: any) => ({ id: s.id, name: s.name, code: s.code, location: s.location }));
  const t = d?.totals;
  const single = d && d.stores.length === 1 ? d.stores[0] : null;

  return (
    <div>
      <PageHeader
        title={matrix && !storeId ? 'Painel Matriz' : single ? single.name : 'Painel'}
        subtitle={d ? `Período: ${d.period.label}` : 'Visão geral da operação'}
        actions={<>
          {(matrix || (user?.stores !== 'ALL' && (user?.stores?.length ?? 0) > 1)) && <StoreSelect value={storeId} onChange={setStoreId} />}
          <PeriodFilter value={period} onChange={setPeriod} />
        </>}
      />
      {dash.error && <ErrorBox onRetry={() => dash.reload()}>{dash.error}</ErrorBox>}
      {dash.loading && !d && <Spinner />}
      {d && t && (
        <div className="space-y-5">
          {can('stores.locate') && d.stores.filter((s: any) => !s.location).length > 0 && (
            <div className="rounded-xl border border-warn/30 bg-warn/10 px-4 py-3 text-sm text-ink-2 flex flex-wrap items-center gap-3">
              <span className="flex-1"><strong className="text-ink">{d.stores.filter((s: any) => !s.location).length} loja(s) ainda sem localização no mapa.</strong> Abra o painel da loja e registre a localização com o celular, de dentro da loja.</span>
              {d.stores.filter((s: any) => !s.location).slice(0, 3).map((s: any) => (
                <Link key={s.id} to={`/unidades/${s.id}`}><Button variant="primary">Registrar {s.name}</Button></Link>
              ))}
            </div>
          )}
          <Card padded={false}>
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 sm:gap-5 p-4 sm:p-5">
              <Stat icon={<StoreIcon className="size-4" />} label={t.stores === 1 ? 'Loja' : 'Lojas cadastradas'} value={num(t.stores)} hint={`${num(t.storesOperating)} em operação`} />
              <Stat icon={<Megaphone className="size-4" />} label="Campanhas ativas" value={num(t.campaignsByStatus.ACTIVE)} hint={`${num(t.campaignsByStatus.PLANNED)} planejadas · ${num(t.campaignsByStatus.PAUSED)} pausadas`} />
              <Stat icon={<Radio className="size-4" />} label="Em campo agora" value={num(t.liveSessions)} hint="rastreamentos em andamento" />
              <Stat icon={<RouteIcon className="size-4" />} label="Percursos no período" value={num(t.sessions)} hint={`${distance(t.distanceM)} percorridos`} />
              <Stat icon={<Clock className="size-4" />} label="Tempo em campo" value={duration(t.fieldSeconds)} hint="soma das sessões" />
              <Stat icon={<Target className="size-4" />} label="Cobertura estimada" value={t.coverage.percent === null ? 'Sem cálculo' : pct(t.coverage.percent)}
                hint={t.coverage.percent === null ? 'faltam ruas planejadas ou dados de GPS' : `${distance(t.coverage.coveredM)} de ${distance(t.coverage.plannedM)} planejados`} />
            </div>
          </Card>

          <div className="grid xl:grid-cols-[1fr_360px] gap-5">
            <Card title="Mapa da operação" padded={false} actions={<Link to="/mapa"><Button variant="ghost" icon={<MapPinned className="size-4" />}>Abrir mapa completo</Button></Link>}>
              <MapView className="h-[300px] sm:h-[420px] rounded-b-2xl" stores={storesForMap} live={liveFeatures} fitKey={`${storeId}-${storesForMap.length}`}
                visible={{ areas: false, streets: false, routes: false, pois: false }}
                onSelect={(s) => s?.kind === 'store' ? setStoreId(s.props.id) : s?.kind === 'live' ? navigate(`/percursos/${s.props.sessionId}`) : null} />
              {storesForMap.every((s: any) => !s.location) && (
                <p className="px-5 py-3 text-xs text-ink-3 border-t border-line">Nenhuma loja tem localização definida ainda. Cadastre o endereço em Unidades para vê-las no mapa.</p>
              )}
            </Card>
            <Card title="Em campo agora" padded={false}>
              {live.data?.length ? (
                <ul className="divide-y divide-line max-h-[420px] overflow-y-auto scroll-thin">
                  {live.data.map((s) => (
                    <li key={s.id}>
                      <Link to={`/percursos/${s.id}`} className="block px-5 py-3 hover:bg-panel-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-ink truncate">{s.userName}</span>
                          <Badge tone={s.state === 'NO_COMMUNICATION' ? 'warn' : 'info'}>{s.stateLabel}</Badge>
                        </div>
                        <div className="text-xs text-ink-3 truncate">{s.campaignName} · {s.storeName}</div>
                        <div className="text-xs text-ink-3">Último ponto {relative(s.lastPointReceivedAt)}</div>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : <EmptyState icon={<Radio className="size-5" />} title="Ninguém em campo agora">Quando um responsável iniciar o rastreamento de uma campanha ativa, ele aparece aqui.</EmptyState>}
            </Card>
          </div>

          {d.stores.length > 0 ? (
            <Card title={d.stores.length > 1 ? 'Comparação entre lojas' : 'Resumo da loja'} padded={false}
              actions={can('reports.view') && <a href={`/api/reports/stores${qs({ storeId, from: period.from, to: period.to, format: 'csv' })}`}><Button variant="ghost" icon={<Download className="size-4" />}>CSV</Button></a>}>
              <Table head={['Loja', 'Campanhas ativas', 'Percursos', 'Distância', 'Tempo em campo', 'Planejado', 'Cobertura estimada', 'Última atividade']}>
                {d.stores.map((s: any) => (
                  <tr key={s.id} className="hover:bg-panel-2 cursor-pointer" onClick={() => setStoreId(s.id)}>
                    <Td><div className="font-medium text-ink">{s.name}</div><div className="text-xs text-ink-3">{s.code}{!s.location && ' · sem localização'}</div></Td>
                    <Td className="tabular">{s.activeCampaigns}</Td>
                    <Td className="tabular">{s.sessions}</Td>
                    <Td className="tabular">{distance(s.distanceM)}</Td>
                    <Td className="tabular">{duration(s.fieldSeconds)}</Td>
                    <Td className="tabular">{s.plannedM ? distance(s.plannedM) : '—'}</Td>
                    <Td>{s.coveragePercent === null
                      ? <span className="text-xs text-ink-3">{s.campaignsInconclusive ? 'Inconclusiva' : 'Sem cálculo'}</span>
                      : <div className="flex items-center gap-2"><div className="w-20 h-1.5 rounded-full bg-line overflow-hidden"><div className="h-full bg-amarelo" style={{ width: `${Math.min(100, s.coveragePercent)}%` }} /></div><span className="tabular text-sm">{pct(s.coveragePercent)}</span></div>}
                    </Td>
                    <Td className="text-xs text-ink-3">{s.lastActivityAt ? relative(s.lastActivityAt) : '—'}</Td>
                  </tr>
                ))}
              </Table>
              <p className="px-5 py-3 text-xs text-ink-3 border-t border-line">
                Cobertura estimada = metros de ruas planejadas por onde o GPS registrou passagem ÷ metros planejados, no último cálculo de cada campanha (ativas, pausadas e concluídas). Não comprova entrega de panfletos.
              </p>
            </Card>
          ) : (
            <Card><EmptyState icon={<StoreIcon className="size-5" />} title="Nenhuma loja cadastrada" action={can('stores.manage') && <Link to="/unidades"><Button variant="primary">Cadastrar loja</Button></Link>}>
              Para começar, cadastre as lojas com o endereço. Depois defina os territórios e crie as campanhas.
            </EmptyState></Card>
          )}
        </div>
      )}
    </div>
  );
}
