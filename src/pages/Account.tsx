import { useState } from 'react';
import { Link } from 'react-router-dom';
import { KeyRound, Hash, MonitorSmartphone, LogOut } from 'lucide-react';
import { ApiError, del, get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLoad } from '../lib/useLoad';
import { dateTime, relative } from '../lib/format';
import { useToast } from '../components/toast';
import { Badge, Button, Card, ErrorBox, Field, Input, PageHeader, Spinner, useConfirm } from '../components/ui';
import { PasswordRules, passwordOk } from './auth/AccessScreens';

export default function Account() {
  const { user, refresh, lockIdleMinutes } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const sessions = useLoad((s) => get('/api/auth/sessions', s), []);
  const [pw, setPw] = useState({ cur: '', next: '', again: '' });
  const [pin, setPin] = useState({ pin: '', cur: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<{ k: string; m: string } | null>(null);

  async function changePassword() {
    if (pw.next !== pw.again) { setErr({ k: 'pw', m: 'As duas senhas não são iguais.' }); return; }
    setBusy('pw'); setErr(null);
    try {
      await post('/api/auth/change-password', { currentPassword: pw.cur, newPassword: pw.next });
      setPw({ cur: '', next: '', again: '' });
      toast('ok', 'Senha alterada. As suas outras sessões foram encerradas.');
      sessions.reload(true);
    } catch (e) { setErr({ k: 'pw', m: e instanceof ApiError ? e.message : 'Não foi possível alterar.' }); } finally { setBusy(null); }
  }
  async function savePin() {
    setBusy('pin'); setErr(null);
    try { await post('/api/auth/pin', { pin: pin.pin, currentPassword: pin.cur }); setPin({ pin: '', cur: '' }); toast('ok', 'PIN salvo.'); refresh(); }
    catch (e) { setErr({ k: 'pin', m: e instanceof ApiError ? e.message : 'Não foi possível salvar.' }); } finally { setBusy(null); }
  }
  async function removePin() {
    setBusy('pin'); setErr(null);
    try { await del('/api/auth/pin', { currentPassword: pin.cur }); setPin({ pin: '', cur: '' }); toast('ok', 'PIN removido.'); refresh(); }
    catch (e) { setErr({ k: 'pin', m: e instanceof ApiError ? e.message : 'Não foi possível remover.' }); } finally { setBusy(null); }
  }
  async function endSession(id: string) {
    try { await del(`/api/auth/sessions/${id}`); sessions.reload(true); } catch (e) { toast('error', e instanceof ApiError ? e.message : 'Não foi possível encerrar.'); }
  }
  async function endOthers() {
    if (!(await confirm.ask('Encerrar outras sessões', 'Encerrar todas as suas sessões, menos esta? Os outros aparelhos vão precisar entrar de novo.', 'Encerrar'))) return;
    try { await post('/api/auth/sessions/end-others'); toast('ok', 'Outras sessões encerradas.'); sessions.reload(true); } catch (e) { toast('error', e instanceof ApiError ? e.message : 'Não foi possível encerrar.'); }
  }

  return (
    <div className="max-w-4xl">
      {confirm.element}
      <PageHeader title="Segurança da conta" subtitle={`${user?.name} · ${user?.email} · ${user?.roleLabel}`} />
      <div className="grid md:grid-cols-2 gap-5">
        <Card title={<span className="flex items-center gap-2"><KeyRound className="size-4 text-accent-ink" /> Trocar senha</span>}>
          <div className="space-y-3">
            {err?.k === 'pw' && <ErrorBox>{err.m}</ErrorBox>}
            <Field label="Senha atual"><Input type="password" autoComplete="current-password" value={pw.cur} onChange={(e) => setPw({ ...pw, cur: e.target.value })} /></Field>
            <Field label="Nova senha"><Input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
            <PasswordRules value={pw.next} />
            <Field label="Repita a nova senha"><Input type="password" autoComplete="new-password" value={pw.again} onChange={(e) => setPw({ ...pw, again: e.target.value })} /></Field>
            <Button variant="primary" loading={busy === 'pw'} disabled={!pw.cur || !passwordOk(pw.next) || !pw.again} onClick={changePassword}>Salvar nova senha</Button>
          </div>
        </Card>
        <Card title={<span className="flex items-center gap-2"><Hash className="size-4 text-accent-ink" /> PIN de desbloqueio</span>}
          actions={<Badge tone={user?.hasPin ? 'ok' : 'neutral'}>{user?.hasPin ? 'Cadastrado' : 'Sem PIN'}</Badge>}>
          <div className="space-y-3">
            <p className="text-sm text-ink-3">Depois de {lockIdleMinutes} minutos sem uso, a tela bloqueia. Com PIN, você desbloqueia mais rápido; sem PIN, pede a senha.</p>
            {err?.k === 'pin' && <ErrorBox>{err.m}</ErrorBox>}
            <Field label={user?.hasPin ? 'Novo PIN (4 a 8 números)' : 'PIN (4 a 8 números)'}><Input inputMode="numeric" type="password" maxLength={8} value={pin.pin} onChange={(e) => setPin({ ...pin, pin: e.target.value.replace(/\D/g, '') })} /></Field>
            <Field label="Senha atual (para confirmar)"><Input type="password" autoComplete="current-password" value={pin.cur} onChange={(e) => setPin({ ...pin, cur: e.target.value })} /></Field>
            <div className="flex gap-2">
              <Button variant="primary" loading={busy === 'pin'} disabled={pin.pin.length < 4 || !pin.cur} onClick={savePin}>Salvar PIN</Button>
              {user?.hasPin && <Button variant="ghost" disabled={!pin.cur} onClick={removePin}>Remover PIN</Button>}
            </div>
          </div>
        </Card>
      </div>
      <Card className="mt-5" title={<span className="flex items-center gap-2"><MonitorSmartphone className="size-4 text-accent-ink" /> Sessões abertas</span>} padded={false}
        actions={<><Link to="/dispositivos"><Button variant="ghost">Meus dispositivos</Button></Link><Button icon={<LogOut className="size-4" />} onClick={endOthers}>Encerrar as outras</Button></>}>
        {!sessions.data ? <Spinner /> : (
          <ul className="divide-y divide-line">
            {sessions.data.map((s: any) => (
              <li key={s.id} className="px-5 py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-ink">{s.deviceName ?? 'Navegador'} {s.current && <Badge tone="yellow" className="ml-1">Esta sessão</Badge>} {s.locked && <Badge tone="warn" className="ml-1">Bloqueada</Badge>}</div>
                  <div className="text-xs text-ink-3">IP {s.ip} · aberta em {dateTime(s.createdAt)} · último uso {relative(s.lastSeenAt)}</div>
                </div>
                {!s.current && <Button variant="ghost" onClick={() => endSession(s.id)}>Encerrar</Button>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
