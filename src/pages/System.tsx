import { useState } from 'react';
import { Copy, Eye, Download, KeyRound, Webhook, Plus, Trash2, Send, Upload, FileText } from 'lucide-react';
import { ApiError, api, del, get, patch, post } from '../lib/api';
import { useLoad } from '../lib/useLoad';
import { bytes, dateTime, duration, relative } from '../lib/format';
import { useToast } from '../components/toast';
import { Badge, Button, Card, Checkbox, Drawer, EmptyState, ErrorBox, Field, Input, Modal, Notice, PageHeader, Spinner, Table, Tabs, Td, Toggle, useConfirm } from '../components/ui';

type Tab = 'resources' | 'server' | 'api' | 'artifacts';

export default function System() {
  const [tab, setTab] = useState<Tab>('resources');
  return (
    <div>
      <PageHeader title="Sistema" subtitle="Recursos, servidor, integrações e documentos da plataforma" />
      <Tabs value={tab} onChange={setTab} items={[
        { value: 'resources', label: 'Recursos da plataforma' }, { value: 'server', label: 'Servidor' },
        { value: 'api', label: 'API & Webhooks' }, { value: 'artifacts', label: 'Artefatos da plataforma' },
      ]} />
      <div className="mt-5">
        {tab === 'resources' && <Resources />}
        {tab === 'server' && <Server />}
        {tab === 'api' && <ApiWebhooks />}
        {tab === 'artifacts' && <Artifacts />}
      </div>
    </div>
  );
}

function Bar({ value, total, label }: { value: number; total: number | null; label: string }) {
  const p = total ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between text-xs text-ink-3 mb-1"><span>{label}</span><span className="tabular">{total ? `${p.toFixed(p < 1 ? 2 : 1)}%` : '—'}</span></div>
      <div className="h-2 rounded-full bg-line overflow-hidden"><div className="h-full bg-amarelo" style={{ width: `${Math.max(p, value ? 0.5 : 0)}%` }} /></div>
    </div>
  );
}

function Resources() {
  const r = useLoad((s) => get('/api/system/resources', s), []);
  if (r.error) return <ErrorBox onRetry={() => r.reload()}>{r.error}</ErrorBox>;
  if (!r.data) return <Spinner />;
  const d = r.data;
  const parts = d.disk.parts;
  return (
    <div className="space-y-5">
      <Notice tone="info">A VPS é compartilhada com outros projetos. Os números abaixo separam o que é do RASTRO do total do servidor.</Notice>
      <div className="grid md:grid-cols-3 gap-5">
        <Card title="Disco">
          <div className="text-2xl font-semibold tabular">{bytes(d.disk.projectBytes)}</div>
          <div className="text-xs text-ink-3 mb-3">do RASTRO, de {bytes(d.disk.serverTotalBytes)} do servidor ({bytes(d.disk.serverFreeBytes)} livres)</div>
          <Bar value={d.disk.projectBytes} total={d.disk.serverTotalBytes} label="RASTRO no disco do servidor" />
        </Card>
        <Card title="Memória">
          <div className="text-2xl font-semibold tabular">{bytes(d.memory.processBytes)}</div>
          <div className="text-xs text-ink-3 mb-3">do processo do RASTRO, de {bytes(d.memory.serverTotalBytes)} ({bytes(d.memory.serverFreeBytes)} livres)</div>
          <Bar value={d.memory.processBytes} total={d.memory.serverTotalBytes} label="RASTRO na memória do servidor" />
        </Card>
        <Card title="Processador">
          <div className="text-2xl font-semibold tabular">{d.cpu.percentOfServer}%</div>
          <div className="text-xs text-ink-3 mb-3">do servidor usado pelo RASTRO ({d.cpu.percentOfCore}% de um núcleo). Servidor inteiro: {d.cpu.serverPercent}% de {d.cpu.cores} núcleos.</div>
          <Bar value={d.cpu.percentOfServer} total={100} label="RASTRO no processador" />
        </Card>
      </div>
      <Card title="Espaço do RASTRO por tipo" padded={false}>
        <Table head={['Parte', 'Tamanho']}>
          {[
            ['Banco de dados (PostgreSQL)', parts.databaseBytes],
            ['Mapa de fundo (.pmtiles)', parts.basemapBytes],
            ['Arquivos gerados (artefatos substituídos)', parts.storageBytes],
            ['Dependências (node_modules)', parts.dependenciesBytes],
            ['Versão compilada (atual + anterior, para voltar se a atualização falhar)', parts.buildBytes],
            ['Código da aplicação', parts.codeBytes],
          ].map(([k, v]) => <tr key={k as string}><Td>{k}</Td><Td className="tabular">{v === null ? 'Não disponível' : bytes(v as number)}</Td></tr>)}
        </Table>
      </Card>
      <Card title="Dados por loja (dentro do banco)" padded={false}>
        {d.disk.perStore.length ? (
          <Table head={['Loja', 'Pontos GPS', 'Tamanho estimado']}>
            {d.disk.perStore.map((s: any) => <tr key={s.id}><Td>{s.name}</Td><Td className="tabular">{s.points.toLocaleString('pt-BR')}</Td><Td className="tabular">{bytes(s.bytes)}</Td></tr>)}
          </Table>
        ) : <EmptyState title="Nenhuma loja cadastrada" />}
        <p className="px-5 py-3 text-xs text-ink-3 border-t border-line">{d.disk.perStoreNote}</p>
      </Card>
      <p className="text-xs text-ink-3">Processo ativo há {duration(d.process.uptimeSeconds)} · Node {d.process.nodeVersion} · {d.process.realtimeConnections} tela(s) conectada(s) em tempo real.</p>
    </div>
  );
}

function Server() {
  const s = useLoad((sig) => get('/api/system/server', sig), []);
  if (s.error) return <ErrorBox onRetry={() => s.reload()}>{s.error}</ErrorBox>;
  if (!s.data) return <Spinner />;
  const d = s.data;
  const rows: [string, string][] = [
    ['Servidor', `${d.hostname} · ${d.platform} (${d.arch})`],
    ['Ligado há', duration(d.uptimeSeconds)],
    ['Processador', `${d.cpuModel ?? '—'} · ${d.cores} núcleos · uso ${d.cpuPercent}% · carga ${d.loadAverage.join(' / ')}`],
    ['Memória', `${bytes(d.memory.totalBytes - d.memory.freeBytes)} usados de ${bytes(d.memory.totalBytes)}`],
    ['Disco', d.disk ? `${bytes(d.disk.usedBytes)} usados de ${bytes(d.disk.totalBytes)} (${bytes(d.disk.freeBytes)} livres)` : 'Não disponível'],
    ['Banco de dados', d.database.connected ? `Conectado · ${d.database.name} · PostgreSQL ${d.database.version} · ${d.database.tables} tabelas` : 'Desconectado'],
    ['Latência do banco', d.database.latencyMs === null ? '—' : `${d.database.latencyMs} ms`],
  ];
  return (
    <Card title="Dados reais da VPS" actions={<Button variant="ghost" onClick={() => s.reload()}>Atualizar</Button>} padded={false}>
      <Table head={['Item', 'Valor']}>{rows.map(([k, v]) => <tr key={k}><Td className="text-ink-3 whitespace-nowrap">{k}</Td><Td className="text-ink">{v}</Td></tr>)}</Table>
      <p className="px-5 py-3 text-xs text-ink-3 border-t border-line">Medido em {dateTime(d.checkedAt)}.</p>
    </Card>
  );
}

function CopyBox({ value }: { value: string }) {
  const toast = useToast();
  return (
    <div className="flex items-center gap-2 rounded-xl border border-line bg-panel-2 px-3 py-2">
      <code className="flex-1 text-xs break-all text-ink">{value}</code>
      <button className="text-ink-3 hover:text-ink" aria-label="Copiar" onClick={() => navigator.clipboard?.writeText(value).then(() => toast('ok', 'Copiado.'))}><Copy className="size-4" /></button>
    </div>
  );
}

function ApiWebhooks() {
  const toast = useToast();
  const confirm = useConfirm();
  const keys = useLoad((s) => get('/api/integrations/keys', s), []);
  const hooks = useLoad((s) => get('/api/integrations/webhooks', s), []);
  const [newKey, setNewKey] = useState(false);
  const [newHook, setNewHook] = useState(false);
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);
  const origin = window.location.origin;

  async function revoke(k: any) {
    if (!(await confirm.ask('Revogar chave', <>Revogar <strong>{k.name}</strong>? O sistema que usa esta chave para de funcionar na hora.</>, 'Revogar', true))) return;
    try { await post(`/api/integrations/keys/${k.id}/revoke`); keys.reload(true); } catch (e) { toast('error', e instanceof ApiError ? e.message : 'Erro.'); }
  }
  async function removeHook(h: any) {
    if (!(await confirm.ask('Remover webhook', <>Remover <strong>{h.name}</strong>?</>, 'Remover', true))) return;
    try { await del(`/api/integrations/webhooks/${h.id}`); hooks.reload(true); } catch (e) { toast('error', e instanceof ApiError ? e.message : 'Erro.'); }
  }
  async function testHook(h: any) {
    try { const r = await post(`/api/integrations/webhooks/${h.id}/test`); toast(r.error ? 'error' : 'ok', r.error ?? `Entregue (resposta ${r.status}).`); hooks.reload(true); }
    catch (e) { toast('error', e instanceof ApiError ? e.message : 'Erro.'); }
  }
  async function toggleHook(h: any, active: boolean) {
    try { await patch(`/api/integrations/webhooks/${h.id}`, { active }); hooks.reload(true); } catch (e) { toast('error', e instanceof ApiError ? e.message : 'Erro.'); }
  }

  return (
    <div className="space-y-5">
      {confirm.element}
      <Card title={<span className="flex items-center gap-2"><KeyRound className="size-4 text-accent-ink" /> Chaves de API</span>} padded={false}
        actions={<Button icon={<Plus className="size-4" />} onClick={() => setNewKey(true)}>Nova chave</Button>}>
        {!keys.data ? <Spinner /> : keys.data.keys.length ? (
          <Table head={['Nome', 'Chave', 'Permissões', 'Criada por', 'Último uso', 'Situação', '']}>
            {keys.data.keys.map((k: any) => (
              <tr key={k.id}>
                <Td className="text-ink">{k.name}</Td><Td className="text-xs font-mono">{k.preview}</Td>
                <Td className="text-xs">{k.scopes.join(', ')}</Td><Td className="text-xs">{k.createdBy}<div className="text-ink-3">{dateTime(k.createdAt)}</div></Td>
                <Td className="text-xs">{k.lastUsedAt ? `${relative(k.lastUsedAt)} · ${k.lastUsedIp}` : 'Nunca usada'}</Td>
                <Td>{k.revoked ? <Badge tone="danger">Revogada</Badge> : <Badge tone="ok">Ativa</Badge>}</Td>
                <Td className="text-right">{!k.revoked && <Button variant="ghost" onClick={() => revoke(k)}>Revogar</Button>}</Td>
              </tr>
            ))}
          </Table>
        ) : <EmptyState icon={<KeyRound className="size-5" />} title="Nenhuma chave de API">Crie uma chave quando outro sistema (ou o adaptador de um equipamento GPS) precisar acessar o RASTRO.</EmptyState>}
      </Card>

      <Card title="Como conectar outro sistema">
        <div className="space-y-3 text-sm text-ink-2">
          <p>1. Crie uma chave com só as permissões necessárias. Ela aparece <strong>uma única vez</strong>: guarde no cofre de senhas do sistema que vai usá-la.</p>
          <p>2. Envie a chave no cabeçalho <code className="text-ink">Authorization: Bearer &lt;chave&gt;</code>. A chave age com as permissões de quem a criou, limitadas às permissões escolhidas, e tudo fica na auditoria como "Nome (API: nome da chave)".</p>
          <p>3. Telas de login, sistema, integração e chaves nunca aceitam chave de API.</p>
          <div className="space-y-2">
            <div className="text-xs text-ink-3">Listar lojas (permissão stores:read):</div>
            <CopyBox value={`curl -H "Authorization: Bearer SUA_CHAVE" ${origin}/api/stores`} />
            <div className="text-xs text-ink-3">Cobertura por campanha (permissão reports:read):</div>
            <CopyBox value={`curl -H "Authorization: Bearer SUA_CHAVE" "${origin}/api/reports/coverage?from=2026-01-01"`} />
            <div className="text-xs text-ink-3">Enviar pontos GPS de uma sessão (permissão tracking:write):</div>
            <CopyBox value={`curl -X POST -H "Authorization: Bearer SUA_CHAVE" -H "Content-Type: application/json" -d '{"points":[{"id":"p-1","lat":-22.9,"lng":-43.2,"accuracy":8,"capturedAt":"2026-01-01T12:00:00Z"}]}' ${origin}/api/tracking/sessions/ID_DA_SESSAO/points`} />
          </div>
        </div>
      </Card>

      <Card title={<span className="flex items-center gap-2"><Webhook className="size-4 text-accent-ink" /> Webhooks</span>} padded={false}
        actions={<Button icon={<Plus className="size-4" />} onClick={() => setNewHook(true)} disabled={hooks.data && !hooks.data.encryptionReady}>Novo webhook</Button>}>
        {hooks.data && !hooks.data.encryptionReady && <div className="p-5"><Notice tone="warn">Configure a SETTINGS_ENCRYPTION_KEY no servidor para criar webhooks.</Notice></div>}
        {!hooks.data ? <Spinner /> : hooks.data.webhooks.length ? (
          <Table head={['Nome', 'Endereço', 'Eventos', 'Último envio', 'Ativo', '']}>
            {hooks.data.webhooks.map((h: any) => (
              <tr key={h.id}>
                <Td className="text-ink">{h.name}</Td><Td className="text-xs break-all max-w-56">{h.url}</Td><Td className="text-xs">{h.events.join(', ')}</Td>
                <Td className="text-xs">{h.lastDeliveryAt ? <>{relative(h.lastDeliveryAt)} · {h.lastError ? <span className="text-danger">{h.lastError}</span> : <span className="text-ok">{h.lastStatus}</span>}</> : 'Nunca'}</Td>
                <Td><Toggle checked={h.active} onChange={(v) => toggleHook(h, v)} label="Ativo" /></Td>
                <Td className="text-right whitespace-nowrap"><Button variant="ghost" icon={<Send className="size-4" />} onClick={() => testHook(h)}>Testar</Button><Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => removeHook(h)}>Remover</Button></Td>
              </tr>
            ))}
          </Table>
        ) : <EmptyState icon={<Webhook className="size-5" />} title="Nenhum webhook">Webhooks avisam outro sistema (só endereços HTTPS) quando um rastreamento começa ou termina, uma campanha muda de situação ou a cobertura é calculada.</EmptyState>}
        <p className="px-5 py-3 text-xs text-ink-3 border-t border-line">Cada envio leva <code>X-Rastro-Timestamp</code> e <code>X-Rastro-Signature: sha256=HMAC(segredo, "timestamp.corpo")</code> para o destino conferir que veio do RASTRO.</p>
      </Card>

      {newKey && keys.data && <NewKey scopes={keys.data.scopes} onClose={() => setNewKey(false)} onCreated={(v) => { setNewKey(false); setSecret({ title: 'Chave criada', value: v }); keys.reload(true); }} />}
      {newHook && hooks.data && <NewHook events={hooks.data.events} onClose={() => setNewHook(false)} onCreated={(v) => { setNewHook(false); setSecret({ title: 'Segredo do webhook', value: v }); hooks.reload(true); }} />}
      <Modal open={Boolean(secret)} title={secret?.title} footer={<Button variant="primary" onClick={() => setSecret(null)}>Já guardei</Button>}>
        <div className="space-y-3">
          <Notice tone="warn">Copie agora. Por segurança, este valor não aparece de novo: o RASTRO guarda só uma versão protegida.</Notice>
          {secret && <CopyBox value={secret.value} />}
        </div>
      </Modal>
    </div>
  );
}

function NewKey({ scopes, onClose, onCreated }: { scopes: { value: string; label: string }[]; onClose: () => void; onCreated: (v: string) => void }) {
  const [name, setName] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true); setError(null);
    try { const r = await post('/api/integrations/keys', { name, scopes: sel }); onCreated(r.key); } catch (e) { setError(e instanceof ApiError ? e.message : 'Erro.'); } finally { setBusy(false); }
  }
  return (
    <Drawer open onClose={onClose} title="Nova chave de API" footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} disabled={!name || !sel.length} onClick={save}>Criar chave</Button></>}>
      <div className="space-y-4">
        {error && <ErrorBox>{error}</ErrorBox>}
        <Field label="Nome (qual sistema vai usar)"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
        <div className="space-y-2">{scopes.map((s) => <Checkbox key={s.value} checked={sel.includes(s.value)} onChange={(v) => setSel((l) => (v ? [...l, s.value] : l.filter((x) => x !== s.value)))} label={s.label} description={s.value} />)}</div>
      </div>
    </Drawer>
  );
}

function NewHook({ events, onClose, onCreated }: { events: { value: string; label: string }[]; onClose: () => void; onCreated: (v: string) => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('https://');
  const [sel, setSel] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true); setError(null);
    try { const r = await post('/api/integrations/webhooks', { name, url, events: sel }); onCreated(r.secret); } catch (e) { setError(e instanceof ApiError ? e.message : 'Erro.'); } finally { setBusy(false); }
  }
  return (
    <Drawer open onClose={onClose} title="Novo webhook" footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} disabled={!name || !url.startsWith('https://') || !sel.length} onClick={save}>Criar</Button></>}>
      <div className="space-y-4">
        {error && <ErrorBox>{error}</ErrorBox>}
        <Field label="Nome"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
        <Field label="Endereço (HTTPS)"><Input value={url} onChange={(e) => setUrl(e.target.value)} maxLength={500} /></Field>
        <div className="space-y-2">{events.map((s) => <Checkbox key={s.value} checked={sel.includes(s.value)} onChange={(v) => setSel((l) => (v ? [...l, s.value] : l.filter((x) => x !== s.value)))} label={s.label} description={s.value} />)}</div>
      </div>
    </Drawer>
  );
}

function Artifacts() {
  const toast = useToast();
  const a = useLoad((s) => get('/api/system/artifacts', s), []);
  const notes = useLoad((s) => get('/api/system/release-notes', s), []);
  const [viewing, setViewing] = useState<any>(null);

  async function replace(art: any, file: File | undefined) {
    if (!file) return;
    try {
      await api(`/api/system/artifacts/${art.id}`, { method: 'PUT', raw: file, headers: { 'Content-Type': 'application/pdf' } });
      toast('ok', 'Artefato substituído.');
      a.reload(true);
    } catch (e) { toast('error', e instanceof ApiError ? e.message : 'Não foi possível substituir.'); }
  }

  return (
    <div className="space-y-5">
      <Card title="Documentos da plataforma" padded={false}>
        {!a.data ? <Spinner /> : a.data.artifacts.length ? (
          <ul className="divide-y divide-line">
            {a.data.artifacts.map((art: any) => (
              <li key={art.id} className="px-5 py-4 flex flex-wrap items-center gap-4">
                <FileText className="size-5 text-accent-ink" />
                <div className="flex-1 min-w-48">
                  <div className="text-sm font-medium text-ink">{art.name} <Badge className="ml-1">v{art.version}</Badge>{art.source === 'substituido' && <Badge tone="warn" className="ml-1">Substituído pela tela</Badge>}</div>
                  <div className="text-xs text-ink-3">{art.description}</div>
                  <div className="text-xs text-ink-3">{art.available ? `Atualizado em ${dateTime(art.updatedAt)} · ${bytes(art.sizeBytes)}` : 'Arquivo ainda não disponível'}</div>
                </div>
                {art.available && <>
                  <Button variant="ghost" icon={<Eye className="size-4" />} onClick={() => setViewing(art)}>Visualizar</Button>
                  <a href={`/api/system/artifacts/${art.id}/download`}><Button variant="ghost" icon={<Download className="size-4" />}>Baixar</Button></a>
                </>}
                {a.data.canReplace && art.file.endsWith('.pdf') && (
                  <label className="inline-flex items-center gap-2 h-10 px-3 rounded-xl text-sm text-ink-2 hover:bg-panel-2 cursor-pointer">
                    <Upload className="size-4" /> Substituir
                    <input type="file" accept="application/pdf" className="hidden" onChange={(e) => replace(art, e.target.files?.[0])} />
                  </label>
                )}
              </li>
            ))}
          </ul>
        ) : <EmptyState title="Nenhum artefato encontrado" />}
        <p className="px-5 py-3 text-xs text-ink-3 border-t border-line">Os documentos ficam no repositório (pasta docs/) e chegam junto com cada atualização. Cronograma e custos: A definir. Toda visualização e download fica na auditoria.</p>
      </Card>
      <Card title="Notas de versão" padded={false}>
        {!notes.data ? <Spinner /> : notes.data.notes.length ? (
          <ul className="divide-y divide-line">
            {notes.data.notes.map((n: any) => (
              <li key={n.sha} className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-2"><span className="font-medium text-ink">{n.title}</span><Badge>#{n.number}</Badge><span className="text-xs text-ink-3">{dateTime(n.date)}</span></div>
                {n.description && <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-ink-2">{n.description}</pre>}
              </li>
            ))}
          </ul>
        ) : <EmptyState title="Nenhuma atualização aplicada ainda">As notas aparecem aqui a partir das descrições dos Pull Requests aplicados pelo botão "Atualizar sistema".</EmptyState>}
      </Card>
      {viewing && (
        <div className="fixed inset-0 z-50 bg-black/70 flex flex-col p-3 sm:p-8">
          <div className="flex items-center justify-between mb-2 text-white"><span className="font-medium">{viewing.name}</span><Button onClick={() => setViewing(null)}>Fechar</Button></div>
          <iframe title={viewing.name} src={`/api/system/artifacts/${viewing.id}/view`} className="flex-1 w-full rounded-xl bg-white" />
        </div>
      )}
    </div>
  );
}
