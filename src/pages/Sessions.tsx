import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Route as RouteIcon } from 'lucide-react';
import { get, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLoad } from '../lib/useLoad';
import { useRealtime } from '../lib/events';
import { dateTime, relative } from '../lib/format';
import type { SessionInfo } from '../lib/types';
import { StoreSelect, PeriodFilter, defaultPeriod } from '../components/filters';
import { Badge, Card, EmptyState, ErrorBox, PageHeader, Select, Spinner, Table, Td, Tone } from '../components/ui';

export const STATE_TONE: Record<string, Tone> = { IN_PROGRESS: 'info', NO_COMMUNICATION: 'warn', SYNC_PENDING: 'info', FINISHED: 'ok', INTERRUPTED: 'warn', WAITING: 'neutral' };

export default function Sessions() {
  const { can, user } = useAuth();
  const [storeId, setStoreId] = useState('');
  const [status, setStatus] = useState('');
  const [period, setPeriod] = useState(defaultPeriod());
  const list = useLoad((s) => get<SessionInfo[]>(`/api/tracking/sessions${qs({ storeId, status, from: period.from, to: period.to })}`, s), [storeId, status, period.from, period.to]);
  useRealtime('tracking', () => list.reload(true), [storeId, status, period.from, period.to]);
  const own = !can('tracking.view');

  return (
    <div>
      <PageHeader title="Percursos" subtitle={own ? 'Seus rastreamentos' : 'Rastreamentos registrados pelo GPS'}
        actions={<>
          {user?.stores === 'ALL' || (user?.stores as any[])?.length > 1 ? <StoreSelect value={storeId} onChange={setStoreId} /> : null}
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
            <option value="">Todas as situações</option><option value="IN_PROGRESS">Em andamento</option><option value="FINISHED">Concluídas</option><option value="INTERRUPTED">Interrompidas</option>
          </Select>
          <PeriodFilter value={period} onChange={setPeriod} />
        </>} />
      {list.error && <ErrorBox onRetry={() => list.reload()}>{list.error}</ErrorBox>}
      <Card padded={false}>
        {list.loading && !list.data ? <Spinner /> : list.data?.length ? (
          <Table head={['Responsável', 'Campanha', 'Loja', 'Situação', 'Início', 'Fim', 'Pontos válidos', 'Último ponto']}>
            {list.data.map((s) => (
              <tr key={s.id} className="hover:bg-panel-2">
                <Td><Link to={`/percursos/${s.id}`} className="font-medium text-ink hover:underline">{s.userName}</Link><div className="text-xs text-ink-3">{s.device?.name ?? '—'}</div></Td>
                <Td className="text-ink-2">{s.campaignName}</Td>
                <Td className="text-ink-2">{s.storeName}</Td>
                <Td><Badge tone={STATE_TONE[s.state]}>{s.stateLabel}</Badge></Td>
                <Td className="text-xs whitespace-nowrap">{dateTime(s.startedAt)}</Td>
                <Td className="text-xs whitespace-nowrap">{s.finishedAt ? dateTime(s.finishedAt) : '—'}</Td>
                <Td className="tabular">{s.acceptedPoints}<span className="text-ink-3"> / {s.pointsCount}</span></Td>
                <Td className="text-xs text-ink-3">{relative(s.lastPointReceivedAt)}</Td>
              </tr>
            ))}
          </Table>
        ) : <EmptyState icon={<RouteIcon className="size-5" />} title="Nenhum percurso no período">Os percursos aparecem aqui quando alguém inicia o rastreamento de uma campanha ativa pelo modo campo.</EmptyState>}
      </Card>
    </div>
  );
}
