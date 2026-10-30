import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Pencil, Search, Save, RefreshCw, Info, Route as RouteIcon, CheckSquare, Square } from 'lucide-react';
import { ApiError, get, post, put, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLoad } from '../lib/useLoad';
import { useRealtime } from '../lib/events';
import { date, dateTime, distance, pct, relative } from '../lib/format';
import type { SessionInfo } from '../lib/types';
import { MapView, MapFeature } from '../components/map/MapView';
import { Legend } from '../components/map/LayerPanel';
import { useToast } from '../components/toast';
import { Badge, Button, Card, Checkbox, EmptyState, ErrorBox, Notice, PageHeader, Spinner, Stat, Table, Tabs, Td, Textarea, Modal, useConfirm } from '../components/ui';
import { CampaignForm, STATUS_TONE } from './Campaigns';

const ACTION_LABEL: Record<string, string> = { DRAFT: 'Voltar para rascunho', PLANNED: 'Marcar como planejada', ACTIVE: 'Ativar', PAUSED: 'Pausar', FINISHED: 'Concluir', CANCELLED: 'Cancelar campanha' };
const STREET_STATUS: Record<string, { label: string; tone: any }> = { DONE: { label: 'Percorrida', tone: 'ok' }, PARTIAL: { label: 'Parcial', tone: 'warn' }, PENDING: { label: 'Não percorrida', tone: 'yellow' } };

export default function CampaignDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const manage = can('campaigns.manage');
  const [tab, setTab] = useState<'plan' | 'coverage' | 'sessions' | 'history'>('plan');
  const [editing, setEditing] = useState(false);
  const [statusTarget, setStatusTarget] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const c = useLoad((s) => get(`/api/campaigns/${id}`, s), [id]);
  const streets = useLoad((s) => get(`/api/campaigns/${id}/streets?candidates=true`, s), [id]);
  const coverage = useLoad((s) => get(`/api/campaigns/${id}/coverage`, s), [id]);
  const sessions = useLoad((s) => get<SessionInfo[]>(`/api/tracking/sessions${qs({ campaignId: id })}`, s), [id]);
  const routes = useLoad((s) => can('tracking.view') ? get(`/api/tracking/routes${qs({ campaignId: id })}`, s) : Promise.resolve({ features: [] }), [id]);
  const history = useLoad((s) => tab === 'history' ? get(`/api/campaigns/${id}/history`, s) : Promise.resolve(null), [id, tab]);
  useRealtime('data', (ev) => { if (ev?.campaignId === id) { c.reload(true); coverage.reload(true); streets.reload(true); } }, [id]);
  useRealtime('tracking', () => { sessions.reload(true); routes.reload(true); }, [id]);

  // Seleção de ruas (planejamento)
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [includeService, setIncludeService] = useState(false);
  const [busyCov, setBusyCov] = useState(false);
  useEffect(() => {
    if (streets.data && selected === null) setSelected(new Set(streets.data.planned.map((p: any) => p.key)));
  }, [streets.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const camp = c.data;
  const candidates: any[] = streets.data?.candidates ?? [];
  const planned: any[] = streets.data?.planned ?? [];
  const editable = manage && camp && !['FINISHED', 'CANCELLED'].includes(camp.status);
  const dirty = selected && (selected.size !== planned.length || planned.some((p) => !selected.has(p.key)));

  const groups = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const cand of candidates) {
      const k = cand.name || 'Ruas sem nome';
      (m.get(k) ?? m.set(k, []).get(k)!).push(cand);
    }
    return [...m.entries()].sort((a, b) => (a[0] === 'Ruas sem nome' ? 1 : b[0] === 'Ruas sem nome' ? -1 : a[0].localeCompare(b[0], 'pt-BR')));
  }, [candidates]);
  const selectedLength = candidates.filter((x) => selected?.has(x.key)).reduce((a, x) => a + x.lengthM, 0);

  const showCandidates = tab === 'plan' && editable && candidates.length > 0;
  const candidateFeatures: MapFeature[] = showCandidates ? candidates.map((x) => ({ type: 'Feature', geometry: x.geometry, properties: { key: x.key, name: x.name ?? 'Rua sem nome', planned: Boolean(selected?.has(x.key)), lengthM: x.lengthM } })) : [];
  const streetFeatures: MapFeature[] = showCandidates ? [] : planned.map((p) => ({ type: 'Feature', geometry: p.geometry, properties: { id: p.id, name: p.name ?? 'Rua sem nome', highway: p.highwayLabel, lengthM: p.lengthM, campaignId: id, campaignName: camp?.name, status: p.coverage?.status ?? null, coveredPct: p.coverage?.coveredPct ?? null } }));
  const areaFeatures: MapFeature[] = camp?.area ? [{ type: 'Feature', geometry: camp.area.geometry, properties: { id: camp.area.id, name: camp.area.name, kind: camp.area.kind, radiusM: camp.area.radiusM } }] : [];

  async function fetchStreets() {
    setFetching(true);
    try {
      const r = await post(`/api/campaigns/${id}/streets/fetch`, { includeService });
      toast('ok', `${r.found} trecho(s) de rua encontrados no território.`);
      await streets.reload();
    } catch (err) { toast('error', err instanceof ApiError ? err.message : 'Não foi possível buscar as ruas.'); } finally { setFetching(false); }
  }

  async function savePlan() {
    if (!selected) return;
    setSaving(true);
    try {
      const r = await put(`/api/campaigns/${id}/streets`, { keys: [...selected] });
      toast('ok', `Plano salvo: ${r.planned} trecho(s) de rua.`);
      await Promise.all([streets.reload(), c.reload(true)]);
      setSelected(null);
    } catch (err) { toast('error', err instanceof ApiError ? err.message : 'Não foi possível salvar.'); } finally { setSaving(false); }
  }

  async function changeStatus() {
    if (!statusTarget) return;
    try {
      await post(`/api/campaigns/${id}/status`, { status: statusTarget, note: note || undefined });
      toast('ok', 'Situação atualizada.');
      setStatusTarget(null); setNote('');
      c.reload(true);
    } catch (err) { toast('error', err instanceof ApiError ? err.message : 'Não foi possível alterar.'); }
  }

  async function recompute() {
    setBusyCov(true);
    try { await post(`/api/campaigns/${id}/coverage`); await Promise.all([coverage.reload(), streets.reload(), c.reload(true)]); toast('ok', 'Cobertura recalculada.'); }
    catch (err) { toast('error', err instanceof ApiError ? err.message : 'Não foi possível calcular.'); } finally { setBusyCov(false); }
  }

  const toggleGroup = (items: any[], on: boolean) => setSelected((s) => { const n = new Set(s); items.forEach((i) => (on ? n.add(i.key) : n.delete(i.key))); return n; });

  if (c.error) return <ErrorBox onRetry={() => c.reload()}>{c.error}</ErrorBox>;
  if (!camp) return <Spinner />;
  const cov = coverage.data;

  return (
    <div>
      {confirm.element}
      <Link to="/campanhas" className="inline-flex items-center gap-1 text-sm text-ink-3 hover:text-ink mb-3"><ArrowLeft className="size-4" /> Campanhas</Link>
      <PageHeader title={camp.name}
        subtitle={<span className="inline-flex flex-wrap items-center gap-2"><Badge tone={STATUS_TONE[camp.status as keyof typeof STATUS_TONE]}>{camp.statusLabel}</Badge>{camp.storeName} · {date(camp.startDate)} a {date(camp.endDate)}</span>}
        actions={manage && <>
          {camp.transitions.map((t: string) => (
            <Button key={t} variant={t === 'ACTIVE' ? 'primary' : t === 'CANCELLED' ? 'danger' : 'secondary'} onClick={() => setStatusTarget(t)}>{ACTION_LABEL[t]}</Button>
          ))}
          {editable && <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Editar</Button>}
        </>} />

      <Card padded={false} className="mb-5">
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-5 p-5">
          <Stat label="Território" value={camp.area?.name ?? 'A definir'} />
          <Stat label="Ruas planejadas" value={camp.streetsCount ? `${camp.streetsCount}` : 'Nenhuma'} hint={camp.streetsCount ? distance(camp.plannedLengthM) : undefined} />
          <Stat label="Responsáveis" value={camp.assignees.length || 'A definir'} hint={camp.assignees.map((a: any) => a.name.split(' ')[0]).join(', ')} />
          <Stat label="Percursos" value={camp.sessionsCount} hint={camp.liveSessions ? `${camp.liveSessions} em campo agora` : undefined} />
          <Stat label="Cobertura estimada" value={cov?.status === 'OK' ? pct(cov.percent) : cov ? 'Sem cálculo válido' : 'Não calculada'} hint={cov ? `calculada ${relative(cov.computedAt)}` : undefined} />
        </div>
        {camp.description && <p className="px-5 pb-4 text-sm text-ink-2 whitespace-pre-line">{camp.description}</p>}
      </Card>

      <Tabs value={tab} onChange={setTab} items={[
        { value: 'plan', label: 'Planejamento e mapa' }, { value: 'coverage', label: 'Cobertura' },
        { value: 'sessions', label: `Percursos (${sessions.data?.length ?? 0})` }, { value: 'history', label: 'Histórico' },
      ]} />

      <div className="mt-5">
        {tab === 'plan' && (
          <div className="grid xl:grid-cols-[1fr_380px] gap-5">
            <div className="space-y-3">
              <Card padded={false} className="overflow-hidden">
                <MapView className="h-[560px]" areas={areaFeatures} streets={streetFeatures} candidates={candidateFeatures} routes={routes.data?.features ?? []}
                  fitKey={`${id}-${areaFeatures.length}-${candidates.length}`}
                  onSelect={(s) => { if (s?.kind === 'candidate' && editable) setSelected((cur) => { const n = new Set(cur); n.has(s.props.key) ? n.delete(s.props.key) : n.add(s.props.key); return n; }); }}
                  visible={{ stores: false, pois: false, live: false }} />
              </Card>
              {!showCandidates && <Legend visible={{ stores: false, areas: true, streets: true, routes: true, pois: false, live: false }} coverageKnown={planned.some((p) => p.coverage)} />}
              {showCandidates && <p className="text-xs text-ink-3">Linhas amarelas grossas = ruas escolhidas para a campanha. Linhas cinzas = ruas encontradas no território, ainda não escolhidas. Clique numa rua no mapa para incluir ou retirar.</p>}
            </div>
            <div className="space-y-3">
              {!camp.area ? (
                <Notice tone="warn">Defina o território da campanha (botão Editar) para buscar as ruas.</Notice>
              ) : editable ? (
                <Card title="Ruas anunciadas">
                  <div className="space-y-3">
                    <p className="text-sm text-ink-3">Busque as ruas do OpenStreetMap dentro do território e escolha quais vão receber panfletagem.</p>
                    <Checkbox checked={includeService} onChange={setIncludeService} label="Incluir vias de serviço e acessos" description="Ruas internas, acessos a condomínios e estacionamentos." />
                    <Button icon={<Search className="size-4" />} loading={fetching} onClick={fetchStreets} className="w-full">{candidates.length ? 'Buscar as ruas de novo' : 'Buscar ruas do território'}</Button>
                    {candidates.length > 0 && <p className="text-xs text-ink-3">Última busca: {dateTime(candidates[0].fetchedAt)}</p>}
                  </div>
                </Card>
              ) : null}

              {showCandidates && selected && (
                <Card title={`${selected.size} trecho(s) escolhidos · ${distance(selectedLength)}`} padded={false}
                  actions={<Button variant="primary" icon={<Save className="size-4" />} loading={saving} disabled={!dirty} onClick={savePlan}>Salvar</Button>}>
                  <div className="flex gap-3 px-5 pb-2 text-xs">
                    <button className="text-accent-ink" onClick={() => setSelected(new Set(candidates.map((x) => x.key)))}>Escolher todas</button>
                    <button className="text-ink-3" onClick={() => setSelected(new Set())}>Limpar</button>
                  </div>
                  <ul className="max-h-[420px] overflow-y-auto scroll-thin divide-y divide-line border-t border-line">
                    {groups.map(([name, items]) => {
                      const on = items.filter((i) => selected.has(i.key)).length;
                      const all = on === items.length;
                      return (
                        <li key={name}>
                          <button className="w-full flex items-center gap-3 px-5 py-2.5 text-left hover:bg-panel-2" onClick={() => toggleGroup(items, !all)}>
                            {all ? <CheckSquare className="size-4 text-accent-ink" /> : on ? <CheckSquare className="size-4 text-ink-3" /> : <Square className="size-4 text-ink-3" />}
                            <span className="flex-1 min-w-0">
                              <span className="block text-sm text-ink truncate">{name}</span>
                              <span className="block text-xs text-ink-3">{items[0].highwayLabel} · {items.length} trecho(s) · {distance(items.reduce((a, i) => a + i.lengthM, 0))}</span>
                            </span>
                            {on > 0 && !all && <span className="text-xs text-ink-3">{on}/{items.length}</span>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              )}
              {!showCandidates && (
                <Card title={`Ruas planejadas (${planned.length})`} padded={false}>
                  {planned.length ? (
                    <ul className="max-h-[460px] overflow-y-auto scroll-thin divide-y divide-line">
                      {planned.map((p) => (
                        <li key={p.id} className="px-5 py-2.5 flex items-center gap-3">
                          <div className="flex-1 min-w-0"><div className="text-sm text-ink truncate">{p.name ?? 'Rua sem nome'}</div><div className="text-xs text-ink-3">{distance(p.lengthM)}</div></div>
                          {p.coverage ? <Badge tone={STREET_STATUS[p.coverage.status].tone}>{STREET_STATUS[p.coverage.status].label} · {pct(p.coverage.coveredPct)}</Badge> : <Badge>Sem cálculo</Badge>}
                        </li>
                      ))}
                    </ul>
                  ) : <EmptyState icon={<RouteIcon className="size-5" />} title="Nenhuma rua planejada">{editable ? 'Use "Buscar ruas do território" para começar o planejamento.' : 'O planejamento desta campanha ainda não foi feito.'}</EmptyState>}
                </Card>
              )}
            </div>
          </div>
        )}

        {tab === 'coverage' && (
          <div className="space-y-5">
            <Card title="Cobertura estimada" actions={manage && <Button icon={<RefreshCw className="size-4" />} loading={busyCov} onClick={recompute}>Recalcular agora</Button>}>
              {!cov ? (
                <EmptyState title="Ainda não calculada">A cobertura é calculada sozinha quando um rastreamento é encerrado. {manage && 'Você também pode calcular agora.'}</EmptyState>
              ) : (
                <div className="space-y-4">
                  {cov.status !== 'OK' && (
                    <Notice tone="warn" icon={<Info className="size-4" />}>
                      {cov.status === 'NO_PLAN' && 'Não há ruas planejadas: não é possível estimar a cobertura.'}
                      {cov.status === 'NO_DATA' && 'Ainda não há pontos de GPS válidos nesta campanha.'}
                      {cov.status === 'INCONCLUSIVE' && `Poucos pontos válidos (${cov.validPoints}) para um resultado confiável. A cobertura fica como inconclusiva.`}
                    </Notice>
                  )}
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
                    <Stat label="Cobertura estimada" value={cov.status === 'OK' ? pct(cov.percent) : '—'} hint={cov.status === 'OK' ? `${distance(cov.coveredLengthM)} de ${distance(cov.plannedLengthM)}` : undefined} />
                    <Stat label="Ruas" value={`${cov.streetsSummary.done} percorridas`} hint={`${cov.streetsSummary.partial} parciais · ${cov.streetsSummary.pending} pendentes`} />
                    <Stat label="Percursos usados" value={cov.sessionsCount} hint={`${distance(cov.distanceM)} de trajeto válido`} />
                    <Stat label="Pontos de GPS" value={`${cov.validPoints} válidos`} hint={`de ${cov.totalPoints} recebidos`} />
                  </div>
                  <details className="text-sm text-ink-2 rounded-xl border border-line px-4 py-3">
                    <summary className="cursor-pointer text-ink">Como este número é calculado (metodologia {cov.methodologyVersion})</summary>
                    <ul className="list-disc pl-5 mt-2 space-y-1 text-ink-3">
                      <li>Só entram pontos de GPS aceitos e com precisão de até {cov.params.maxAccuracyM} m.</li>
                      <li>O percurso é interrompido quando passam mais de {cov.params.maxGapSeconds} s ou {cov.params.maxGapMeters} m entre pontos, e saltos acima de {cov.params.maxSpeedKmh} km/h são descartados. Pontos distantes nunca são ligados.</li>
                      <li>Cada rua planejada é verificada a cada poucos metros: o trecho conta como percorrido quando o percurso passou a até {cov.params.bufferM} m dele.</li>
                      <li>Rua percorrida: a partir de {cov.params.donePct}% do comprimento. Parcial: a partir de {cov.params.partialPct}%.</li>
                      <li>Cobertura estimada = metros percorridos das ruas planejadas ÷ metros planejados. Com menos de {cov.params.minPoints} pontos válidos o resultado é inconclusivo.</li>
                      <li>O GPS mostra o deslocamento do aparelho; não comprova a entrega dos panfletos.</li>
                    </ul>
                  </details>
                </div>
              )}
            </Card>
            {cov?.streets?.length > 0 && (
              <Card title="Situação por rua" padded={false}>
                <Table head={['Rua', 'Comprimento', 'Percorrido', 'Situação']}>
                  {[...cov.streets].sort((a: any, b: any) => a.coveredPct - b.coveredPct).map((s: any) => (
                    <tr key={s.id}>
                      <Td className="text-ink">{s.name ?? 'Rua sem nome'}</Td>
                      <Td className="tabular">{distance(s.lengthM)}</Td>
                      <Td className="tabular">{distance(s.coveredM)} ({pct(s.coveredPct)})</Td>
                      <Td><Badge tone={STREET_STATUS[s.status].tone}>{STREET_STATUS[s.status].label}</Badge></Td>
                    </tr>
                  ))}
                </Table>
              </Card>
            )}
          </div>
        )}

        {tab === 'sessions' && (
          <Card padded={false}>
            {sessions.data?.length ? (
              <Table head={['Responsável', 'Situação', 'Início', 'Fim', 'Pontos', 'Último ponto']}>
                {sessions.data.map((s) => (
                  <tr key={s.id} className="hover:bg-panel-2">
                    <Td><Link to={`/percursos/${s.id}`} className="text-ink font-medium hover:underline">{s.userName}</Link></Td>
                    <Td><Badge tone={s.state === 'IN_PROGRESS' ? 'info' : s.state === 'FINISHED' ? 'ok' : s.state === 'NO_COMMUNICATION' || s.state === 'INTERRUPTED' ? 'warn' : 'neutral'}>{s.stateLabel}</Badge></Td>
                    <Td className="text-xs">{dateTime(s.startedAt)}</Td>
                    <Td className="text-xs">{s.finishedAt ? dateTime(s.finishedAt) : '—'}</Td>
                    <Td className="tabular">{s.acceptedPoints}</Td>
                    <Td className="text-xs text-ink-3">{relative(s.lastPointReceivedAt)}</Td>
                  </tr>
                ))}
              </Table>
            ) : <EmptyState icon={<RouteIcon className="size-5" />} title="Nenhum percurso ainda">Os percursos aparecem quando um responsável iniciar o rastreamento pelo modo campo.</EmptyState>}
          </Card>
        )}

        {tab === 'history' && (
          <Card padded={false}>
            {!history.data ? <Spinner /> : history.data.length ? (
              <ul className="divide-y divide-line">
                {history.data.map((h: any, i: number) => (
                  <li key={i} className="px-5 py-3">
                    <div className="flex justify-between gap-3 text-sm"><span className="text-ink font-medium">{h.action}</span><span className="text-xs text-ink-3">{dateTime(h.at)}</span></div>
                    <div className="text-xs text-ink-3">{h.userName}{Object.keys(h.details || {}).length ? ' · ' + Object.entries(h.details).map(([k, v]) => `${k}: ${v}`).join(' · ') : ''}</div>
                  </li>
                ))}
              </ul>
            ) : <EmptyState title="Sem histórico" />}
          </Card>
        )}
      </div>

      {editing && <CampaignForm campaign={camp} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); c.reload(true); }} />}
      <Modal open={Boolean(statusTarget)} onClose={() => setStatusTarget(null)} title={statusTarget ? ACTION_LABEL[statusTarget] : ''}
        footer={<><Button variant="ghost" onClick={() => setStatusTarget(null)}>Voltar</Button><Button variant={statusTarget === 'CANCELLED' ? 'danger' : 'primary'} onClick={changeStatus}>Confirmar</Button></>}>
        <div className="space-y-3 text-sm text-ink-2">
          {statusTarget === 'ACTIVE' && <p>Com a campanha ativa, os responsáveis conseguem iniciar o rastreamento pelo modo campo.</p>}
          {statusTarget === 'PAUSED' && <p>Novos rastreamentos ficam bloqueados. Os que já estão em andamento continuam enviando pontos até serem encerrados.</p>}
          {statusTarget === 'FINISHED' && <p>A campanha deixa de aceitar novos rastreamentos e o planejamento fica travado. É possível reabrir depois.</p>}
          {statusTarget === 'CANCELLED' && <p>Cancelar é definitivo: a campanha não poderá ser reativada. O histórico é mantido.</p>}
          <Textarea placeholder="Observação (opcional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </div>
      </Modal>
    </div>
  );
}
