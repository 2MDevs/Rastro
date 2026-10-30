import { useState } from 'react';
import { Download, Printer, BarChart3 } from 'lucide-react';
import { get, qs } from '../lib/api';
import { useLoad } from '../lib/useLoad';
import { date, dateTime, distance, pct } from '../lib/format';
import { StoreSelect, PeriodFilter, defaultPeriod } from '../components/filters';
import { Button, Card, EmptyState, ErrorBox, PageHeader, Select, Spinner, Table, Tabs, Td } from '../components/ui';

type Kind = 'coverage' | 'sessions' | 'stores';

export default function Reports() {
  const [kind, setKind] = useState<Kind>('coverage');
  const [storeId, setStoreId] = useState('');
  const [status, setStatus] = useState('');
  const [period, setPeriod] = useState(defaultPeriod());
  const params = { storeId, status, from: period.from, to: period.to };
  const data = useLoad((s) => get(`/api/reports/${kind}${qs(params)}`, s), [kind, storeId, status, period.from, period.to]);
  const rows: any[] = data.data?.rows ?? [];

  return (
    <div>
      <PageHeader title="Relatórios" subtitle={`Período: ${data.data?.period ?? '—'}`}
        actions={<>
          <a href={`/api/reports/${kind}${qs({ ...params, format: 'csv' })}`}><Button icon={<Download className="size-4" />}>Exportar CSV</Button></a>
          <Button icon={<Printer className="size-4" />} onClick={() => window.print()}>Imprimir / PDF</Button>
        </>} />
      <Tabs value={kind} onChange={(v) => { setKind(v); setStatus(''); }} items={[
        { value: 'coverage', label: 'Cobertura por campanha' }, { value: 'sessions', label: 'Histórico de percursos' }, { value: 'stores', label: 'Comparação entre lojas' },
      ]} />
      <div className="flex flex-wrap items-center gap-2 my-4 no-print">
        <StoreSelect value={storeId} onChange={setStoreId} />
        {kind === 'coverage' && (
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
            <option value="">Todas as situações</option><option value="ACTIVE">Ativas</option><option value="PAUSED">Pausadas</option><option value="FINISHED">Concluídas</option>
          </Select>
        )}
        {kind === 'sessions' && (
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
            <option value="">Todas as situações</option><option value="IN_PROGRESS">Em andamento</option><option value="FINISHED">Concluídas</option><option value="INTERRUPTED">Interrompidas</option>
          </Select>
        )}
        <PeriodFilter value={period} onChange={setPeriod} />
      </div>
      {data.error && <ErrorBox onRetry={() => data.reload()}>{data.error}</ErrorBox>}
      <Card padded={false}>
        {data.loading && !data.data ? <Spinner /> : !rows.length ? (
          <EmptyState icon={<BarChart3 className="size-5" />} title="Sem dados para os filtros escolhidos" />
        ) : kind === 'coverage' ? (
          <Table head={['Loja', 'Campanha', 'Situação', 'Período', 'Ruas (percorridas / parciais / pendentes)', 'Planejado', 'Percorrido', 'Cobertura estimada', 'Calculado em']}>
            {rows.map((r) => (
              <tr key={r.id}>
                <Td>{r.store}</Td><Td className="text-ink">{r.campaign}</Td><Td>{r.status}</Td>
                <Td className="text-xs whitespace-nowrap">{date(r.startDate)} – {date(r.endDate)}</Td>
                <Td className="tabular">{r.streets} ({r.streetsDone} / {r.streetsPartial} / {r.streetsPending})</Td>
                <Td className="tabular">{r.plannedM === null ? '—' : distance(r.plannedM)}</Td>
                <Td className="tabular">{r.coveredM === null ? '—' : distance(r.coveredM)}</Td>
                <Td>{r.percent === null ? <span className="text-xs text-ink-3">{r.coverageStatus}</span> : pct(r.percent)}</Td>
                <Td className="text-xs">{r.computedAt ? dateTime(r.computedAt) : '—'}</Td>
              </tr>
            ))}
          </Table>
        ) : kind === 'sessions' ? (
          <Table head={['Loja', 'Campanha', 'Responsável', 'Início', 'Fim', 'Duração', 'Distância', 'Pontos válidos', 'Situação']}>
            {rows.map((r) => (
              <tr key={r.id}>
                <Td>{r.store}</Td><Td>{r.campaign}</Td><Td className="text-ink">{r.person}</Td>
                <Td className="text-xs whitespace-nowrap">{dateTime(r.startedAt)}</Td><Td className="text-xs whitespace-nowrap">{r.finishedAt ? dateTime(r.finishedAt) : '—'}</Td>
                <Td className="tabular">{r.durationMinutes === null ? '—' : `${r.durationMinutes} min`}</Td>
                <Td className="tabular">{distance(r.distanceM)}</Td><Td className="tabular">{r.validPoints} / {r.points}</Td><Td>{r.state}</Td>
              </tr>
            ))}
          </Table>
        ) : (
          <Table head={['Loja', 'Campanhas ativas', 'Percursos', 'Pessoas', 'Distância', 'Planejado', 'Percorrido', 'Cobertura estimada']}>
            {rows.map((r) => (
              <tr key={r.id}>
                <Td className="text-ink">{r.name} <span className="text-ink-3">({r.code})</span></Td>
                <Td className="tabular">{r.activeCampaigns}</Td><Td className="tabular">{r.sessions}</Td><Td className="tabular">{r.people}</Td>
                <Td className="tabular">{distance(r.distanceM)}</Td><Td className="tabular">{r.plannedM ? distance(r.plannedM) : '—'}</Td>
                <Td className="tabular">{r.coveredM ? distance(r.coveredM) : '—'}</Td>
                <Td>{r.coveragePercent === null ? <span className="text-xs text-ink-3">Sem cálculo</span> : pct(r.coveragePercent)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <p className="text-xs text-ink-3 mt-3">Cobertura estimada a partir do GPS (metodologia v1): indica por onde o aparelho passou, não comprova a entrega dos panfletos. Exportações ficam registradas na auditoria.</p>
    </div>
  );
}
