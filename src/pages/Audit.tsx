import { useState } from 'react';
import { Download, ShieldCheck, ScrollText } from 'lucide-react';
import { ApiError, get, post, qs } from '../lib/api';
import { useLoad } from '../lib/useLoad';
import { dateTime, daysAgo, today } from '../lib/format';
import { useToast } from '../components/toast';
import { Badge, Button, Card, EmptyState, ErrorBox, Input, PageHeader, Select, Spinner, Table, Td, Tone } from '../components/ui';

const RT: Record<string, Tone> = { SUCCESS: 'ok', DENIED: 'warn', BLOCKED: 'danger', FAILURE: 'danger' };

export default function Audit() {
  const toast = useToast();
  const [f, setF] = useState({ from: daysAgo(6), to: today(), userId: '', action: '', result: '', scope: '', q: '' });
  const [extra, setExtra] = useState<any[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [verifying, setVerifying] = useState(false);
  const params = qs(f);
  const list = useLoad(async (s) => { const r = await get(`/api/audit${params}`, s); setExtra([]); setNext(r.nextBefore); return r; }, [params]);

  async function more() {
    if (!next) return;
    const r = await get(`/api/audit${qs({ ...f, before: next })}`);
    setExtra((e) => [...e, ...r.entries]);
    setNext(r.nextBefore);
  }
  async function verify() {
    setVerifying(true);
    try {
      const r = await post('/api/audit/verify');
      toast(r.ok ? 'ok' : 'error', r.ok ? `Corrente íntegra: ${r.checked} registro(s) conferidos.` : `Adulteração detectada no registro nº ${r.brokenAt?.seq}.`);
      list.reload(true);
    } catch (err) { toast('error', err instanceof ApiError ? err.message : 'Não foi possível conferir.'); } finally { setVerifying(false); }
  }
  const entries = [...(list.data?.entries ?? []), ...extra];
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  return (
    <div>
      <PageHeader title="Auditoria" subtitle="Registro imutável de tudo o que acontece no sistema"
        actions={<>
          <Button icon={<ShieldCheck className="size-4" />} loading={verifying} onClick={verify}>Conferir integridade</Button>
          <a href={`/api/audit/export.csv${params}`}><Button icon={<Download className="size-4" />}>Exportar CSV</Button></a>
        </>} />
      <Card className="mb-4">
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Input type="date" value={f.from} onChange={(e) => set('from')(e.target.value)} aria-label="De" />
          <Input type="date" value={f.to} onChange={(e) => set('to')(e.target.value)} aria-label="Até" />
          <Select value={f.userId} onChange={(e) => set('userId')(e.target.value)}><option value="">Todas as pessoas</option>{list.data?.people.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
          <Select value={f.action} onChange={(e) => set('action')(e.target.value)}><option value="">Todas as ações</option>{list.data?.actions.map((a: any) => <option key={a.value} value={a.value}>{a.label}</option>)}</Select>
          <Select value={f.result} onChange={(e) => set('result')(e.target.value)}><option value="">Todos os resultados</option><option value="SUCCESS">Sucesso</option><option value="DENIED">Negado</option><option value="BLOCKED">Bloqueado</option><option value="FAILURE">Falha</option></Select>
          <Input placeholder="Loja / escopo" value={f.scope} onChange={(e) => set('scope')(e.target.value)} />
          <Input className="lg:col-span-2" placeholder="Buscar (pessoa, item, detalhes, IP)" value={f.q} onChange={(e) => set('q')(e.target.value)} />
        </div>
      </Card>
      {list.error && <ErrorBox onRetry={() => list.reload()}>{list.error}</ErrorBox>}
      <Card padded={false}>
        {!list.data ? <Spinner /> : entries.length ? (
          <>
            <Table head={['Data e hora', 'Pessoa', 'Loja / escopo', 'Ação', 'Item', 'Detalhes', 'Resultado', 'IP · dispositivo']}>
              {entries.map((e) => (
                <tr key={e.id} className="align-top">
                  <Td className="text-xs whitespace-nowrap tabular">{dateTime(e.at)}</Td>
                  <Td><div className="text-ink">{e.userName}</div><div className="text-xs text-ink-3">{e.role}</div></Td>
                  <Td className="text-xs">{e.scope}</Td>
                  <Td className="text-ink">{e.actionLabel}</Td>
                  <Td className="text-xs max-w-48 break-words">{e.targetName ?? '—'}</Td>
                  <Td className="text-xs text-ink-2 max-w-72 break-words">{e.details || '—'}</Td>
                  <Td><Badge tone={RT[e.result]}>{e.resultLabel}</Badge></Td>
                  <Td className="text-xs text-ink-3">{e.ip}<div>{e.device}</div></Td>
                </tr>
              ))}
            </Table>
            {next && <div className="p-4 text-center"><Button onClick={more}>Carregar mais</Button></div>}
          </>
        ) : <EmptyState icon={<ScrollText className="size-5" />} title="Nenhum registro com estes filtros" />}
      </Card>
      <p className="text-xs text-ink-3 mt-3">Cada registro guarda o hash SHA-256 do anterior. O banco recusa alterar ou apagar registros; "Conferir integridade" refaz a corrente e aponta qualquer adulteração.</p>
    </div>
  );
}
