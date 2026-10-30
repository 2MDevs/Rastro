import { useState } from 'react';
import { Smartphone, Monitor, ShieldCheck, Ban, Trash2, RotateCcw, Plus, Radio } from 'lucide-react';
import { ApiError, del, get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLoad } from '../lib/useLoad';
import { dateTime, relative } from '../lib/format';
import { useToast } from '../components/toast';
import { Badge, Button, Card, Drawer, EmptyState, ErrorBox, Field, Input, Notice, PageHeader, Select, Spinner, Table, Tabs, Td, Tone, useConfirm } from '../components/ui';

const TONE: Record<string, Tone> = { TRUSTED: 'ok', PENDING: 'warn', BLOCKED: 'danger', REVOKED: 'neutral', ACTIVE: 'ok' };

export default function Devices() {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const manage = can('devices.manage');
  const [tab, setTab] = useState<'access' | 'trackers'>('access');
  const devices = useLoad((s) => get('/api/devices', s), []);
  const trackers = useLoad((s) => get('/api/trackers', s), []);
  const [adding, setAdding] = useState(false);

  async function act(d: any, action: 'approve' | 'revoke' | 'block' | 'unblock' | 'remove') {
    const texts: Record<string, [string, string, string, boolean]> = {
      approve: ['Aprovar dispositivo', `Marcar "${d.name}" como confiável por 30 dias? Ele deixa de pedir o código por e-mail nesse período.`, 'Aprovar', false],
      revoke: ['Revogar confiança', `Revogar a confiança de "${d.name}"? As sessões dele são encerradas agora e o próximo acesso pedirá o código por e-mail.`, 'Revogar', true],
      block: ['Bloquear dispositivo', `Bloquear "${d.name}"? As sessões dele são encerradas agora e ele não consegue mais entrar.`, 'Bloquear', true],
      unblock: ['Retirar bloqueio', `Retirar o bloqueio de "${d.name}"? O próximo acesso pedirá o código por e-mail.`, 'Retirar bloqueio', false],
      remove: ['Remover dispositivo', `Remover "${d.name}" da lista? As sessões dele são encerradas.`, 'Remover', true],
    };
    const [t, b, c, danger] = texts[action];
    if (!(await confirm.ask(t, b, c, danger))) return;
    try {
      if (action === 'remove') await del(`/api/devices/${d.id}`);
      else if (action === 'block' || action === 'unblock') await post(`/api/devices/${d.id}/block`, { blocked: action === 'block' });
      else await post(`/api/devices/${d.id}/${action}`);
      toast('ok', 'Feito.');
      devices.reload(true);
    } catch (err) { toast('error', err instanceof ApiError ? err.message : 'Não foi possível concluir.'); }
  }

  async function trackerStatus(t: any, status: string) {
    const label = status === 'ACTIVE' ? 'Reativar' : status === 'BLOCKED' ? 'Bloquear' : 'Revogar';
    if (!(await confirm.ask(`${label} aparelho`, status === 'ACTIVE' ? `Reativar "${t.name}" para rastreamento?` : `${label} "${t.name}"? Rastreamentos em andamento nele serão interrompidos e novos pontos serão recusados.`, label, status !== 'ACTIVE'))) return;
    try { await post(`/api/trackers/${t.id}/status`, { status }); toast('ok', 'Feito.'); trackers.reload(true); }
    catch (err) { toast('error', err instanceof ApiError ? err.message : 'Não foi possível concluir.'); }
  }

  return (
    <div>
      {confirm.element}
      <PageHeader title="Dispositivos" subtitle={manage ? 'Todos os aparelhos que acessam o sistema ou enviam GPS' : 'Seus aparelhos'} />
      <Tabs value={tab} onChange={setTab} items={[{ value: 'access', label: 'Acesso ao sistema' }, { value: 'trackers', label: 'Aparelhos de rastreamento' }]} />
      <div className="mt-5">
        {tab === 'access' && (
          <Card padded={false}>
            {devices.error && <div className="p-5"><ErrorBox>{devices.error}</ErrorBox></div>}
            {!devices.data ? <Spinner /> : devices.data.devices.length ? (
              <Table head={[...(manage ? ['Pessoa'] : []), 'Dispositivo', 'IP', 'Primeiro acesso', 'Último acesso', 'Situação', 'Confiança até', '']}>
                {devices.data.devices.map((d: any) => (
                  <tr key={d.id}>
                    {manage && <Td className="text-ink">{d.userName}</Td>}
                    <Td>
                      <div className="flex items-center gap-2">{d.deviceType === 'mobile' ? <Smartphone className="size-4 text-ink-3" /> : <Monitor className="size-4 text-ink-3" />}
                        <div><div className="text-ink">{d.name}{d.current && <Badge tone="yellow" className="ml-2">Este</Badge>}</div><div className="text-xs text-ink-3">{d.browser} · {d.os}</div></div></div>
                    </Td>
                    <Td className="text-xs tabular">{d.ip}</Td>
                    <Td className="text-xs">{dateTime(d.firstSeenAt)}</Td>
                    <Td className="text-xs">{relative(d.lastSeenAt)}</Td>
                    <Td><Badge tone={TONE[d.status]}>{d.statusLabel}</Badge>{d.activeSessions > 0 && <span className="text-xs text-ink-3 ml-2">{d.activeSessions} sessão(ões)</span>}</Td>
                    <Td className="text-xs">{d.trustedUntil ? dateTime(d.trustedUntil) : '—'}</Td>
                    <Td className="text-right whitespace-nowrap">
                      {d.status !== 'TRUSTED' && d.status !== 'BLOCKED' && <Button variant="ghost" icon={<ShieldCheck className="size-4" />} onClick={() => act(d, 'approve')}>Aprovar</Button>}
                      {d.status === 'TRUSTED' && <Button variant="ghost" icon={<RotateCcw className="size-4" />} onClick={() => act(d, 'revoke')}>Revogar</Button>}
                      {manage && d.status !== 'BLOCKED' && <Button variant="ghost" icon={<Ban className="size-4" />} onClick={() => act(d, 'block')}>Bloquear</Button>}
                      {manage && d.status === 'BLOCKED' && <Button variant="ghost" onClick={() => act(d, 'unblock')}>Desbloquear</Button>}
                      <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => act(d, 'remove')}>Remover</Button>
                    </Td>
                  </tr>
                ))}
              </Table>
            ) : <EmptyState title="Nenhum dispositivo registrado" />}
          </Card>
        )}
        {tab === 'trackers' && (
          <div className="space-y-4">
            {manage && <div className="flex justify-end"><Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Cadastrar equipamento GPS</Button></div>}
            <Card padded={false}>
              {!trackers.data ? <Spinner /> : trackers.data.length ? (
                <Table head={['Aparelho', 'Tipo', 'Responsável', 'Situação', 'Percursos', 'Última comunicação', '']}>
                  {trackers.data.map((t: any) => (
                    <tr key={t.id}>
                      <Td className="text-ink">{t.name}{t.live && <Badge tone="info" className="ml-2"><Radio className="size-3" /> em campo</Badge>}</Td>
                      <Td className="text-xs">{t.kindLabel}</Td>
                      <Td>{t.userName ?? '—'}</Td>
                      <Td><Badge tone={TONE[t.status]}>{t.statusLabel}</Badge></Td>
                      <Td className="tabular">{t.sessions}</Td>
                      <Td className="text-xs">{t.lastSeenAt ? relative(t.lastSeenAt) : 'Nunca'}</Td>
                      <Td className="text-right whitespace-nowrap">
                        {manage && t.status === 'ACTIVE' && <Button variant="ghost" icon={<Ban className="size-4" />} onClick={() => trackerStatus(t, 'BLOCKED')}>Bloquear</Button>}
                        {manage && t.status !== 'ACTIVE' && <Button variant="ghost" onClick={() => trackerStatus(t, 'ACTIVE')}>Reativar</Button>}
                        {t.status === 'ACTIVE' && <Button variant="ghost" icon={<RotateCcw className="size-4" />} onClick={() => trackerStatus(t, 'REVOKED')}>Revogar</Button>}
                      </Td>
                    </tr>
                  ))}
                </Table>
              ) : <EmptyState icon={<Smartphone className="size-5" />} title="Nenhum aparelho de rastreamento">O aparelho é registrado sozinho quando alguém abre o modo campo pela primeira vez.</EmptyState>}
            </Card>
            <Notice tone="info">Equipamento GPS dedicado: o modelo e o protocolo ainda estão A definir. O cadastro abaixo já deixa o aparelho vinculado a um responsável; o envio dos pontos depende do adaptador do fabricante (ver docs/integracao-gps.md).</Notice>
          </div>
        )}
      </div>
      {adding && <TrackerForm onClose={() => setAdding(false)} onSaved={() => { setAdding(false); trackers.reload(true); }} />}
    </div>
  );
}

function TrackerForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const users = useLoad((s) => get('/api/users', s), []);
  const [name, setName] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true); setError(null);
    try { await post('/api/trackers', { name, identifier, userId }); toast('ok', 'Equipamento cadastrado.'); onSaved(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.'); } finally { setBusy(false); }
  }
  return (
    <Drawer open onClose={onClose} title="Cadastrar equipamento GPS"
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={save} disabled={!name || !identifier || !userId}>Salvar</Button></>}>
      <div className="space-y-4">
        {error && <ErrorBox>{error}</ErrorBox>}
        <Field label="Nome"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Rastreador 01" /></Field>
        <Field label="Identificador do equipamento" hint="IMEI ou número de série. Fica guardado só como hash."><Input value={identifier} onChange={(e) => setIdentifier(e.target.value)} /></Field>
        <Field label="Responsável">
          <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Escolha</option>
            {(users.data?.users ?? []).filter((u: any) => u.status === 'ACTIVE').map((u: any) => <option key={u.id} value={u.id}>{u.name} · {u.roleLabel}</option>)}
          </Select>
        </Field>
      </div>
    </Drawer>
  );
}
