import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { Lock, RefreshCw, CloudDownload, Mail, ShieldCheck, UserCog, Map as MapIcon, Target, FileCode2, CheckCircle2, XCircle } from 'lucide-react';
import { ApiError, get, post, put } from '../lib/api';
import { useLoad } from '../lib/useLoad';
import { bytes, dateTime } from '../lib/format';
import { useToast } from '../components/toast';
import { Badge, Button, Card, ErrorBox, Field, Input, Modal, Notice, PageHeader, Select, Spinner, Table, Td } from '../components/ui';

const SOURCE: Record<string, string> = { database: 'Banco', env: '.env', default: 'Padrão' };

export default function Integration() {
  const access = useLoad((s) => get('/api/integration/access', s), []);
  const [unlocked, setUnlocked] = useState(false);
  useEffect(() => { if (access.data?.unlocked) setUnlocked(true); }, [access.data]);
  if (!access.data) return <Spinner />;
  if (!unlocked) return <Reauth onOk={() => setUnlocked(true)} />;
  return <IntegrationBody onExpired={() => setUnlocked(false)} />;
}

function Reauth({ onOk }: { onOk: () => void }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await post('/api/auth/reauth', { password: pw }); onOk(); } catch (err) { setError(err instanceof ApiError ? err.message : 'Erro.'); } finally { setBusy(false); }
  }
  return (
    <div className="max-w-sm mx-auto mt-10">
      <Card>
        <form onSubmit={submit} className="space-y-4 text-center">
          <Lock className="size-8 mx-auto text-accent-ink" />
          <div><h1 className="font-semibold text-ink">Área restrita</h1><p className="text-sm text-ink-3 mt-1">Confirme a sua senha. O acesso vale por 10 minutos.</p></div>
          {error && <ErrorBox>{error}</ErrorBox>}
          <Input type="password" autoFocus autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} aria-label="Senha" />
          <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={!pw}>Continuar</Button>
        </form>
      </Card>
    </div>
  );
}

function Section({ icon, title, children, actions }: { icon: ReactNode; title: string; children: ReactNode; actions?: ReactNode }) {
  return <Card title={<span className="flex items-center gap-2"><span className="text-accent-ink">{icon}</span>{title}</span>} actions={actions}>{children}</Card>;
}

function IntegrationBody({ onExpired }: { onExpired: () => void }) {
  const toast = useToast();
  const s = useLoad((sig) => get('/api/integration/settings', sig), []);
  const [values, setValues] = useState<Record<string, string>>({});
  const [savingGroup, setSavingGroup] = useState<string | null>(null);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (s.error && /Confirme a sua senha/.test(s.error)) onExpired();
  }, [s.error]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (s.data) setValues(Object.fromEntries(s.data.settings.filter((x: any) => x.kind !== 'secret').map((x: any) => [x.key, x.value ?? ''])));
  }, [s.data]);

  if (s.error && !s.data) return <ErrorBox onRetry={() => s.reload()}>{s.error}</ErrorBox>;
  if (!s.data) return <Spinner />;
  const d = s.data;
  const byGroup = (g: string) => d.settings.filter((x: any) => x.group === g);

  async function save(group: string) {
    setSavingGroup(group);
    const keys = byGroup(group).map((x: any) => x.key);
    const payload = Object.fromEntries(keys.map((k: string) => [k, values[k] ?? '']));
    try {
      await put('/api/integration/settings', { values: payload });
      toast('ok', 'Configurações salvas.');
      setValues((v) => { const n = { ...v }; keys.forEach((k: string) => { if (d.settings.find((x: any) => x.key === k)?.kind === 'secret') delete n[k]; }); return n; });
      s.reload(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'REAUTH_REQUIRED') return onExpired();
      toast('error', err instanceof ApiError ? err.message : 'Não foi possível salvar.');
    } finally { setSavingGroup(null); }
  }

  async function testSmtp() {
    setTesting(true);
    try {
      const r = await post('/api/integration/smtp/test', { to: testTo || undefined });
      toast('ok', r.setupCompleted ? 'E-mail enviado. Configuração inicial concluída: o código por e-mail (2FA) passa a valer para todos.' : 'E-mail de teste enviado.');
      s.reload(true);
    } catch (err) { toast('error', err instanceof ApiError ? err.message : 'Falha no envio.'); } finally { setTesting(false); }
  }

  async function sendAdminReset() {
    try { await post('/api/integration/admin/send-reset'); toast('ok', 'Link de redefinição enviado ao administrador principal.'); }
    catch (err) { toast('error', err instanceof ApiError ? err.message : 'Não foi possível enviar.'); }
  }

  const fields = (group: string) => (
    <div className="grid sm:grid-cols-2 gap-4">
      {byGroup(group).map((x: any) => (
        <Field key={x.key} label={x.label} hint={<>{x.help ? `${x.help} ` : ''}<span className="text-ink-3">Origem: {SOURCE[x.source]}{x.updatedBy ? ` (${x.updatedBy}, ${dateTime(x.updatedAt)})` : ''}{x.default && x.kind !== 'secret' ? ` · padrão: ${x.default || 'vazio'}` : ''}</span></>}>
          {x.kind === 'bool' ? (
            <Select value={values[x.key] ?? 'false'} onChange={(e) => setValues({ ...values, [x.key]: e.target.value })}><option value="false">Não</option><option value="true">Sim</option></Select>
          ) : x.kind === 'secret' ? (
            <Input type="password" autoComplete="new-password" placeholder={x.configured ? `Configurada (termina em ${x.last4}). Preencha só para trocar.` : 'Não configurada'}
              value={values[x.key] ?? ''} onChange={(e) => setValues({ ...values, [x.key]: e.target.value })} />
          ) : (
            <Input type={x.kind === 'int' ? 'number' : 'text'} min={x.min ?? undefined} max={x.max ?? undefined} value={values[x.key] ?? ''} onChange={(e) => setValues({ ...values, [x.key]: e.target.value })} />
          )}
        </Field>
      ))}
    </div>
  );
  const saveBtn = (g: string) => <div className="flex justify-end mt-4"><Button variant="primary" loading={savingGroup === g} onClick={() => save(g)}>Salvar</Button></div>;

  return (
    <div className="space-y-5 max-w-5xl">
      <PageHeader title="Integração" subtitle="Exclusivo do desenvolvedor. Valores vazios voltam para o .env ou para o padrão." />
      {!d.encryptionKeyConfigured && <Notice tone="warn">A SETTINGS_ENCRYPTION_KEY não está configurada no servidor: senhas e segredos não podem ser salvos por esta tela.</Notice>}
      {d.initialSetupMode && <Notice tone="warn">Modo de configuração inicial: o código por e-mail (2FA) ainda não está valendo. Configure o e-mail abaixo e envie o e-mail de teste para ativá-lo para todos.</Notice>}

      <UpdatePanel onExpired={onExpired} />

      <Section icon={<Mail className="size-4" />} title="E-mail (SMTP)" actions={<Badge tone={d.smtpConfigured ? 'ok' : 'warn'}>{d.smtpConfigured ? 'Configurado' : 'Incompleto'}</Badge>}>
        {fields('smtp')}
        {saveBtn('smtp')}
        <div className="mt-4 pt-4 border-t border-line flex flex-wrap items-end gap-2">
          <Field label="Enviar e-mail de teste para" className="flex-1 min-w-60"><Input type="email" placeholder="Seu e-mail (padrão)" value={testTo} onChange={(e) => setTestTo(e.target.value)} /></Field>
          <Button loading={testing} onClick={testSmtp}>Enviar e-mail de teste</Button>
        </div>
      </Section>

      <Section icon={<ShieldCheck className="size-4" />} title="Segurança e sessão">{fields('security')}{saveBtn('security')}</Section>

      <Section icon={<UserCog className="size-4" />} title="Administrador principal">
        {fields('admin')}
        <div className="mt-3 text-sm text-ink-2">
          {d.admin ? <>Usuário encontrado: <strong className="text-ink">{d.admin.email}</strong> · criado em {dateTime(d.admin.createdAt)} · último acesso {d.admin.lastLoginAt ? dateTime(d.admin.lastLoginAt) : 'nunca'}{d.admin.mustChangePassword && ' · troca de senha pendente'}</> : 'Nenhum usuário com este e-mail.'}
        </div>
        <div className="flex justify-end gap-2 mt-4"><Button onClick={sendAdminReset} disabled={!d.admin}>Enviar redefinição de senha</Button><Button variant="primary" loading={savingGroup === 'admin'} onClick={() => save('admin')}>Salvar</Button></div>
      </Section>

      <Section icon={<MapIcon className="size-4" />} title="Mapas">
        <Notice tone="info">
          Pasta do mapa de fundo no servidor: <code>{d.basemapDir}</code>. Arquivos encontrados: {d.basemapFiles.length ? d.basemapFiles.map((f: any) => `${f.name} (${bytes(f.sizeBytes)})`).join(', ') : 'nenhum'}. Veja docs/mapa-de-fundo.md para gerar o arquivo da região.
        </Notice>
        <div className="mt-4">{fields('map')}</div>
        {saveBtn('map')}
      </Section>

      <Section icon={<Target className="size-4" />} title="Cálculo de cobertura e trajetos">
        <p className="text-sm text-ink-3 mb-4">Valores iniciais, a calibrar no teste de campo com a loja-piloto. Mudanças valem para os próximos cálculos; use "Recalcular" na campanha para aplicar aos dados já recebidos (os pontos originais ficam guardados).</p>
        {fields('coverage')}
        {saveBtn('coverage')}
      </Section>

      <Section icon={<FileCode2 className="size-4" />} title="Variáveis do .env (somente leitura)">
        <Table head={['Variável', 'Situação', 'Valor']}>
          {d.env.map((e: any) => (
            <tr key={e.key}>
              <Td className="font-mono text-xs">{e.key}</Td>
              <Td>{e.isSet ? <span className="inline-flex items-center gap-1 text-ok text-xs"><CheckCircle2 className="size-3.5" /> Definida</span> : <span className="inline-flex items-center gap-1 text-ink-3 text-xs"><XCircle className="size-3.5" /> Não definida</span>}</Td>
              <Td className="text-xs break-all">{e.secret ? (e.isSet ? 'oculto (segredo)' : '—') : (e.value ?? '—')}</Td>
            </tr>
          ))}
        </Table>
      </Section>
    </div>
  );
}

function UpdatePanel({ onExpired }: { onExpired: () => void }) {
  const toast = useToast();
  const [check, setCheck] = useState(false);
  const st = useLoad((s) => get(`/api/system-update/status${check ? '?check=true' : ''}`, s), [check]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!st.data?.running) return;
    const t = setInterval(() => st.reload(true), 4000);
    return () => clearInterval(t);
  }, [st.data?.running]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (st.error && /Confirme a sua senha/.test(st.error)) onExpired(); }, [st.error]); // eslint-disable-line react-hooks/exhaustive-deps

  async function request() {
    setBusy(true);
    try { await post('/api/system-update', { password: pw }); setConfirmOpen(false); setPw(''); toast('ok', 'Atualização iniciada.'); st.reload(true); }
    catch (err) { toast('error', err instanceof ApiError ? err.message : 'Não foi possível iniciar.'); } finally { setBusy(false); }
  }

  const d = st.data;
  const state = d?.status?.state;
  return (
    <Section icon={<CloudDownload className="size-4" />} title="Atualização do sistema"
      actions={<>
        <Button icon={<RefreshCw className="size-4" />} onClick={() => { setCheck(true); st.reload(); }} loading={st.loading && check}>Verificar</Button>
        <Button variant="primary" disabled={!d?.updateAvailable || d?.running || !d?.installed} onClick={() => setConfirmOpen(true)}>Atualizar</Button>
      </>}>
      {!d ? <Spinner /> : (
        <div className="space-y-3 text-sm">
          {!d.installed && <Notice tone="warn">A atualização automática ainda não foi instalada nesta VPS. Rode uma vez, na pasta do projeto: <code>sudo bash scripts/install-auto-update.sh</code></Notice>}
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="rounded-xl border border-line p-3"><div className="text-xs text-ink-3">Versão rodando</div><div className="text-ink">{d.current ? `${d.current.short} · ${d.current.message}` : 'Desconhecida'}</div><div className="text-xs text-ink-3">{d.current && dateTime(d.current.date)}</div></div>
            <div className="rounded-xl border border-line p-3"><div className="text-xs text-ink-3">GitHub ({d.branch})</div><div className="text-ink">{d.latest ? `${d.latest.short}${d.latest.message ? ` · ${d.latest.message}` : ''}` : 'Sem acesso ao GitHub'}</div>
              <div className="text-xs">{d.updateAvailable ? <span className="text-accent-ink">Nova versão disponível</span> : <span className="text-ok">Na versão mais recente</span>}</div></div>
          </div>
          {d.changes?.length > 0 && (
            <div className="rounded-xl border border-line p-3">
              <div className="text-xs text-ink-3 mb-1">O que muda</div>
              <ul className="space-y-1">{d.changes.map((c: any) => <li key={c.sha} className="text-ink-2">• {c.title} <span className="text-xs text-ink-3">({c.sha})</span></li>)}</ul>
            </div>
          )}
          {d.status && (
            <div className="flex items-center gap-2">
              <span className="text-ink-3">Última atualização:</span>
              <Badge tone={state === 'success' || state === 'up_to_date' ? 'ok' : state === 'running' ? 'info' : 'danger'}>{state === 'running' ? 'Em andamento' : state === 'success' ? 'Concluída' : state === 'up_to_date' ? 'Já estava atualizado' : 'Falhou (versão anterior restaurada)'}</Badge>
              <span className="text-ink-2">{d.status.message}</span>
            </div>
          )}
          {d.log && <details><summary className="cursor-pointer text-ink-3">Ver registro</summary><pre className="mt-2 max-h-72 overflow-auto scroll-thin rounded-xl bg-panel-2 border border-line p-3 text-xs whitespace-pre-wrap">{d.log}</pre></details>}
        </div>
      )}
      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Atualizar o sistema"
        footer={<><Button variant="ghost" onClick={() => setConfirmOpen(false)}>Cancelar</Button><Button variant="primary" loading={busy} disabled={!pw} onClick={request}>Atualizar agora</Button></>}>
        <div className="space-y-3 text-sm text-ink-2">
          <p>O sistema vai baixar a versão {d?.latest?.short} da main, gerar a versão nova, reiniciar e testar. Se algo falhar, volta sozinho para a versão atual. As telas abertas recarregam ao final.</p>
          <Field label="Confirme a sua senha"><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /></Field>
        </div>
      </Modal>
    </Section>
  );
}
