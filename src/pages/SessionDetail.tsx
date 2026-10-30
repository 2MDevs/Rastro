import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Download, Square } from 'lucide-react';
import { ApiError, get, post, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLoad } from '../lib/useLoad';
import { useRealtime } from '../lib/events';
import { dateTime, distance, duration, relative } from '../lib/format';
import { MapView, MapFeature } from '../components/map/MapView';
import { Legend } from '../components/map/LayerPanel';
import { useToast } from '../components/toast';
import { Badge, Button, Card, ErrorBox, Notice, PageHeader, Spinner, Stat, useConfirm } from '../components/ui';
import { STATE_TONE } from './Sessions';

export default function SessionDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const s = useLoad((sig) => get(`/api/tracking/sessions/${id}`, sig), [id]);
  const streets = useLoad((sig) => s.data ? get(`/api/campaigns/map/streets${qs({ campaignId: s.data.campaignId })}`, sig) : Promise.resolve({ features: [] }), [s.data?.campaignId]);
  const [fitKey] = useState(() => Date.now());
  useRealtime('tracking', (ev) => { if (ev?.sessionId === id || ev?.session?.id === id) s.reload(true); }, [id]);

  const d = s.data;
  const route: MapFeature[] = useMemo(() => d?.track.segments.length ? [{ type: 'Feature', geometry: { type: 'MultiLineString', coordinates: d.track.segments }, properties: { sessionId: d.id, userName: d.userName, campaignName: d.campaignName, storeName: d.storeName, startedAt: d.startedAt, finishedAt: d.finishedAt, distanceM: d.track.distanceM } }] : [], [d]);
  const live: MapFeature[] = d?.status === 'IN_PROGRESS' && d.lastPosition ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: [d.lastPosition.lng, d.lastPosition.lat] }, properties: { sessionId: d.id, userName: d.userName, accuracyM: d.lastPosition.accuracyM, stale: d.state === 'NO_COMMUNICATION', lastAt: d.lastPointReceivedAt } }] : [];

  async function finish() {
    if (!(await confirm.ask('Encerrar rastreamento', 'Encerrar este rastreamento em nome do responsável? Use quando a sessão ficou aberta por engano. Pontos que ainda estiverem no aparelho continuam podendo ser enviados.', 'Encerrar'))) return;
    try { await post(`/api/tracking/sessions/${id}/finish`, { reason: 'USER', note: 'Encerrada pela gestão' }); toast('ok', 'Rastreamento encerrado.'); s.reload(); }
    catch (err) { toast('error', err instanceof ApiError ? err.message : 'Não foi possível encerrar.'); }
  }

  if (s.error) return <ErrorBox onRetry={() => s.reload()}>{s.error}</ErrorBox>;
  if (!d) return <Spinner />;
  const end = d.finishedAt ?? d.lastPointCapturedAt;
  const seconds = end && d.startedAt ? (new Date(end).getTime() - new Date(d.startedAt).getTime()) / 1000 : null;
  const t = d.track;

  return (
    <div>
      {confirm.element}
      <Link to="/percursos" className="inline-flex items-center gap-1 text-sm text-ink-3 hover:text-ink mb-3"><ArrowLeft className="size-4" /> Percursos</Link>
      <PageHeader title={`Percurso de ${d.userName}`} subtitle={<span className="inline-flex flex-wrap items-center gap-2"><Badge tone={STATE_TONE[d.state]}>{d.stateLabel}</Badge><Link className="hover:underline" to={`/campanhas/${d.campaignId}`}>{d.campaignName}</Link> · {d.storeName}</span>}
        actions={<>
          {can('tracking.view') && <a href={`/api/tracking/sessions/${id}/points.csv`}><Button icon={<Download className="size-4" />}>Pontos brutos (CSV)</Button></a>}
          {d.status === 'IN_PROGRESS' && can('campaigns.manage') && <Button variant="danger" icon={<Square className="size-4" />} onClick={finish}>Encerrar</Button>}
        </>} />
      {d.state === 'NO_COMMUNICATION' && <div className="mb-4"><Notice tone="warn">Sem comunicação desde {relative(d.lastPointReceivedAt ?? d.startedAt)}. O aparelho pode estar sem internet (os pontos chegam depois) ou o rastreamento parou.</Notice></div>}
      {d.state === 'SYNC_PENDING' && <div className="mb-4"><Notice tone="info">O aparelho informou {d.pendingPointsReported} ponto(s) ainda não enviados. Eles aparecem aqui quando a internet voltar.</Notice></div>}
      <Card padded={false} className="mb-5">
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-5 p-5">
          <Stat label="Distância válida" value={distance(t.distanceM)} hint={`${t.gaps} interrupção(ões) de sinal`} />
          <Stat label="Duração" value={duration(seconds)} hint={`${dateTime(d.startedAt)} → ${d.finishedAt ? dateTime(d.finishedAt) : 'em andamento'}`} />
          <Stat label="Pontos válidos" value={`${t.validPoints} de ${t.totalPoints}`} hint={`${t.discarded.lowAccuracy} imprecisos · ${t.discarded.jumps} saltos · ${t.discarded.rejected} recusados`} />
          <Stat label="Precisão mediana" value={t.medianAccuracyM === null ? '—' : `± ${t.medianAccuracyM} m`} hint={`limite para contar: ${t.params.maxAccuracyM} m`} />
          <Stat label="Atraso de envio" value={t.avgSyncDelaySeconds === null ? '—' : duration(t.avgSyncDelaySeconds)} hint="média entre captura e recebimento" />
        </div>
      </Card>
      <div className="grid xl:grid-cols-[1fr_320px] gap-5">
        <Card padded={false} className="overflow-hidden">
          <MapView className="h-[520px]" routes={route} live={live} streets={streets.data?.features ?? []} fitKey={`${fitKey}-${route.length}`} visible={{ stores: false, areas: false, pois: false }} />
          {!route.length && <p className="px-5 py-3 text-sm text-ink-3 border-t border-line">Ainda não há trecho válido para desenhar. {t.totalPoints ? 'Os pontos recebidos estão fora do limite de precisão ou isolados.' : 'Nenhum ponto recebido.'}</p>}
        </Card>
        <div className="space-y-4">
          <Legend visible={{ stores: false, areas: false, streets: true, routes: true, pois: false, live: d.status === 'IN_PROGRESS' }} coverageKnown={(streets.data?.features ?? []).some((f: any) => f.properties.status)} />
          <Card title="Detalhes">
            <dl className="text-sm space-y-2">
              <div className="flex justify-between gap-2"><dt className="text-ink-3">Aparelho</dt><dd className="text-ink text-right">{d.device?.name ?? '—'}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-ink-3">Primeiro ponto</dt><dd className="text-ink">{dateTime(t.firstPointAt)}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-ink-3">Último ponto</dt><dd className="text-ink">{dateTime(t.lastPointAt)}</dd></div>
              {d.finishReason && <div className="flex justify-between gap-2"><dt className="text-ink-3">Encerramento</dt><dd className="text-ink text-right">{d.finishReason}</dd></div>}
              {t.rejectedByReason.map((r: any) => <div key={r.reason} className="flex justify-between gap-2"><dt className="text-ink-3">Recusados: {r.reason}</dt><dd className="text-ink">{r.count}</dd></div>)}
            </dl>
            <p className="text-xs text-ink-3 mt-3">Trechos sem sinal (mais de {t.params.maxGapSeconds} s ou {t.params.maxGapMeters} m entre pontos) não são ligados no mapa.</p>
          </Card>
        </div>
      </div>
    </div>
  );
}
