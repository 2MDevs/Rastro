import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Megaphone } from 'lucide-react';
import { ApiError, get, patch, post, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLoad } from '../lib/useLoad';
import { useRealtime } from '../lib/events';
import { date, distance, pct } from '../lib/format';
import type { Area, Campaign, CampaignStatus } from '../lib/types';
import { StoreSelect } from '../components/filters';
import { useToast } from '../components/toast';
import { Badge, Button, Card, Drawer, EmptyState, ErrorBox, Field, Input, PageHeader, Select, Spinner, Table, Td, Textarea, Tone, Checkbox } from '../components/ui';

export const STATUS_TONE: Record<CampaignStatus, Tone> = { DRAFT: 'neutral', PLANNED: 'info', ACTIVE: 'ok', PAUSED: 'warn', FINISHED: 'yellow', CANCELLED: 'danger' };

export function CoverageCell({ c }: { c: Campaign['coverage'] }) {
  if (!c) return <span className="text-xs text-ink-3">Não calculada</span>;
  if (c.status !== 'OK' || c.percent === null) {
    const label: Record<string, string> = { INCONCLUSIVE: 'Inconclusiva', NO_DATA: 'Sem dados de GPS', NO_PLAN: 'Sem ruas planejadas' };
    return <span className="text-xs text-ink-3">{label[c.status] ?? '—'}</span>;
  }
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 rounded-full bg-line overflow-hidden"><div className="h-full bg-amarelo" style={{ width: `${Math.min(100, c.percent)}%` }} /></div>
      <span className="tabular text-sm">{pct(c.percent)}</span>
    </div>
  );
}

export default function Campaigns() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [storeId, setStoreId] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const list = useLoad((s) => get<Campaign[]>(`/api/campaigns${qs({ storeId, status })}`, s), [storeId, status]);
  useRealtime('data', (ev) => { if (['campaigns', 'coverage', 'streets'].includes(ev?.kind)) list.reload(true); }, [storeId, status]);

  return (
    <div>
      <PageHeader title="Campanhas" subtitle="Operações de distribuição planejadas por loja e território"
        actions={<>
          <StoreSelect value={storeId} onChange={setStoreId} />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
            <option value="">Todas as situações</option>
            <option value="DRAFT">Rascunho</option><option value="PLANNED">Planejada</option><option value="ACTIVE">Ativa</option>
            <option value="PAUSED">Pausada</option><option value="FINISHED">Concluída</option><option value="CANCELLED">Cancelada</option>
          </Select>
          {can('campaigns.manage') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Nova campanha</Button>}
        </>} />
      {list.error && <ErrorBox onRetry={() => list.reload()}>{list.error}</ErrorBox>}
      <Card padded={false}>
        {list.loading && !list.data ? <Spinner /> : list.data?.length ? (
          <Table head={['Campanha', 'Loja', 'Situação', 'Período', 'Ruas planejadas', 'Responsáveis', 'Percursos', 'Cobertura estimada']}>
            {list.data.map((c) => (
              <tr key={c.id} className="hover:bg-panel-2 cursor-pointer" onClick={() => navigate(`/campanhas/${c.id}`)}>
                <Td><Link to={`/campanhas/${c.id}`} className="font-medium text-ink hover:underline" onClick={(e) => e.stopPropagation()}>{c.name}</Link>{c.liveSessions > 0 && <Badge tone="info" className="ml-2">{c.liveSessions} em campo</Badge>}</Td>
                <Td className="text-ink-2">{c.storeName}</Td>
                <Td><Badge tone={STATUS_TONE[c.status]}>{c.statusLabel}</Badge></Td>
                <Td className="text-xs text-ink-2 whitespace-nowrap">{date(c.startDate)} – {date(c.endDate)}</Td>
                <Td className="tabular">{c.streetsCount ? `${c.streetsCount} · ${distance(c.plannedLengthM)}` : <span className="text-ink-3">Nenhuma</span>}</Td>
                <Td className="text-xs text-ink-2">{c.assignees.length ? c.assignees.map((a) => a.name.split(' ')[0]).join(', ') : <span className="text-ink-3">A definir</span>}</Td>
                <Td className="tabular">{c.sessionsCount}</Td>
                <Td><CoverageCell c={c.coverage} /></Td>
              </tr>
            ))}
          </Table>
        ) : <EmptyState icon={<Megaphone className="size-5" />} title="Nenhuma campanha" action={can('campaigns.manage') && <Button variant="primary" onClick={() => setCreating(true)}>Criar campanha</Button>}>
            Uma campanha reúne o território, as ruas planejadas, os responsáveis e os percursos de uma operação.
          </EmptyState>}
      </Card>
      {creating && <CampaignForm onClose={() => setCreating(false)} onSaved={(id) => navigate(`/campanhas/${id}`)} defaultStoreId={storeId} />}
    </div>
  );
}

export function CampaignForm({ campaign, onClose, onSaved, defaultStoreId }: { campaign?: any; onClose: () => void; onSaved: (id: string) => void; defaultStoreId?: string }) {
  const toast = useToast();
  const [storeId, setStoreId] = useState(campaign?.storeId ?? defaultStoreId ?? '');
  const [name, setName] = useState(campaign?.name ?? '');
  const [description, setDescription] = useState(campaign?.description ?? '');
  const [areaId, setAreaId] = useState(campaign?.areaId ?? '');
  const [startDate, setStart] = useState(campaign?.startDate ?? '');
  const [endDate, setEnd] = useState(campaign?.endDate ?? '');
  const [assignees, setAssignees] = useState<string[]>(campaign?.assignees?.map((a: any) => a.id) ?? []);
  const [areas, setAreas] = useState<Area[]>([]);
  const [people, setPeople] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!storeId) { setAreas([]); setPeople([]); return; }
    get<Area[]>(`/api/territory/areas${qs({ storeId })}`).then(setAreas).catch(() => setAreas([]));
    get(`/api/stores/${storeId}/people`).then(setPeople).catch(() => setPeople([]));
  }, [storeId]);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true); setError(null);
    const body = { name, description: description || null, areaId: areaId || null, startDate: startDate || null, endDate: endDate || null, assigneeIds: assignees };
    try {
      if (campaign) {
        await patch(`/api/campaigns/${campaign.id}`, body);
        toast('ok', 'Campanha atualizada.');
        onSaved(campaign.id);
      } else {
        const r = await post('/api/campaigns', { ...body, storeId });
        toast('ok', 'Campanha criada como rascunho.');
        onSaved(r.id);
      }
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.'); } finally { setBusy(false); }
  }

  return (
    <Drawer open onClose={onClose} title={campaign ? 'Editar campanha' : 'Nova campanha'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={() => submit()} disabled={!name || !storeId}>Salvar</Button></>}>
      <form onSubmit={submit} className="space-y-4">
        {error && <ErrorBox>{error}</ErrorBox>}
        {!campaign && <Field label="Loja"><StoreSelect value={storeId} onChange={setStoreId} allowAll={false} className="w-full" /></Field>}
        <Field label="Nome"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
        <Field label="Descrição"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} /></Field>
        <Field label="Território" hint={!areas.length ? 'Esta loja ainda não tem território. Crie em Territórios.' : 'As ruas planejadas são buscadas dentro deste território.'}>
          <Select value={areaId} onChange={(e) => setAreaId(e.target.value)}>
            <option value="">A definir</option>
            {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Início" hint="Vazio = A definir"><Input type="date" value={startDate ?? ''} onChange={(e) => setStart(e.target.value)} /></Field>
          <Field label="Término previsto" hint="Vazio = A definir"><Input type="date" value={endDate ?? ''} min={startDate || undefined} onChange={(e) => setEnd(e.target.value)} /></Field>
        </div>
        <div>
          <span className="block text-xs font-medium text-ink-2 mb-1.5">Responsáveis pela execução</span>
          {people.length ? (
            <div className="space-y-2 max-h-56 overflow-y-auto scroll-thin rounded-xl border border-line p-3">
              {people.map((p) => (
                <Checkbox key={p.id} checked={assignees.includes(p.id)} onChange={(v) => setAssignees((l) => (v ? [...l, p.id] : l.filter((x) => x !== p.id)))}
                  label={p.name} description={p.roleLabel} />
              ))}
            </div>
          ) : <p className="text-xs text-ink-3">{storeId ? 'Nenhuma pessoa vinculada a esta loja. Cadastre os divulgadores em Usuários.' : 'Escolha a loja primeiro.'}</p>}
          <p className="text-xs text-ink-3 mt-1.5">Só os responsáveis conseguem iniciar o rastreamento desta campanha.</p>
        </div>
      </form>
    </Drawer>
  );
}
