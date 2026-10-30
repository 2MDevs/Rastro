import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Lock, LogOut } from 'lucide-react';
import { ApiError, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Logo, Symbol } from '../../brand/Logo';
import { Button, ErrorBox, Field, Input, Notice, Spinner } from '../../components/ui';

export function PasswordRules({ value }: { value: string }) {
  const rules = [
    { ok: value.length >= 10, label: 'Pelo menos 10 caracteres' },
    { ok: /[A-Za-z]/.test(value), label: 'Pelo menos uma letra' },
    { ok: /\d/.test(value), label: 'Pelo menos um número' },
  ];
  return (
    <ul className="space-y-1 text-xs">
      {rules.map((r) => (
        <li key={r.label} className={r.ok ? 'text-ok' : 'text-ink-3'}><Check className="size-3.5 inline mr-1" />{r.label}</li>
      ))}
    </ul>
  );
}
export const passwordOk = (v: string) => v.length >= 10 && /[A-Za-z]/.test(v) && /\d/.test(v);

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-full flex items-center justify-center p-6 bg-bg">
      <div className="w-full max-w-md">
        <div className="text-ink mb-8 flex justify-center"><Logo height={44} tagline /></div>
        <div className="rounded-2xl bg-panel border border-line p-6">{children}</div>
      </div>
    </div>
  );
}

/** Link recebido por e-mail: criar a primeira senha ou redefinir */
export function SetPassword() {
  const token = window.location.hash.replace(/^#/, '');
  const [state, setState] = useState<'check' | 'ok' | 'invalid' | 'done'>('check');
  const [info, setInfo] = useState<{ purpose: string; name: string } | null>(null);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) { setState('invalid'); return; }
    post('/api/auth/password-link/check', { token }).then((r) => { setInfo(r); setState('ok'); })
      .catch((err) => { setError(err instanceof ApiError ? err.message : 'Link inválido.'); setState('invalid'); });
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pw !== pw2) { setError('As duas senhas não são iguais.'); return; }
    setBusy(true); setError(null);
    try {
      await post('/api/auth/password-link/complete', { token, newPassword: pw });
      history.replaceState(null, '', '/definir-senha');
      setState('done');
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.'); } finally { setBusy(false); }
  }

  return (
    <Frame>
      {state === 'check' && <Spinner label="Conferindo o link..." />}
      {state === 'invalid' && (
        <div className="space-y-4">
          <ErrorBox>{error ?? 'Este link é inválido.'}</ErrorBox>
          <Link to="/" className="text-sm underline text-ink-2">Ir para o login</Link>
        </div>
      )}
      {state === 'done' && (
        <div className="space-y-4">
          <Notice tone="ok">Senha salva. No primeiro acesso de cada aparelho, vamos enviar um código para o seu e-mail.</Notice>
          <Link to="/"><Button variant="primary" className="w-full">Entrar no RASTRO</Button></Link>
        </div>
      )}
      {state === 'ok' && info && (
        <form onSubmit={submit} className="space-y-4">
          <div>
            <h1 className="text-lg font-semibold text-ink">{info.purpose === 'invite' ? `Olá, ${info.name}! Crie a sua senha` : 'Crie uma nova senha'}</h1>
            <p className="text-sm text-ink-3 mt-1">A senha é pessoal. Ninguém da equipe vai pedir que você a informe.</p>
          </div>
          {error && <ErrorBox>{error}</ErrorBox>}
          <Field label="Nova senha"><Input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
          <PasswordRules value={pw} />
          <Field label="Repita a senha"><Input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></Field>
          <Button type="submit" variant="primary" loading={busy} className="w-full" disabled={!passwordOk(pw) || !pw2}>Salvar senha</Button>
        </form>
      )}
    </Frame>
  );
}

/** Troca obrigatória (administrador inicial / senha provisória) */
export function ForceChangePassword() {
  const { refresh, logout } = useAuth();
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pw !== pw2) { setError('As duas senhas não são iguais.'); return; }
    setBusy(true); setError(null);
    try {
      await post('/api/auth/change-password', { currentPassword: cur, newPassword: pw });
      await refresh();
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.'); } finally { setBusy(false); }
  }
  return (
    <Frame>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <h1 className="text-lg font-semibold text-ink">Troque a sua senha para continuar</h1>
          <p className="text-sm text-ink-3 mt-1">Este é um acesso com senha provisória. Escolha uma senha só sua.</p>
        </div>
        {error && <ErrorBox>{error}</ErrorBox>}
        <Field label="Senha atual (provisória)"><Input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
        <Field label="Nova senha"><Input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
        <PasswordRules value={pw} />
        <Field label="Repita a nova senha"><Input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></Field>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={logout}>Sair</Button>
          <Button type="submit" variant="primary" loading={busy} className="flex-1" disabled={!cur || !passwordOk(pw) || !pw2}>Salvar nova senha</Button>
        </div>
      </form>
    </Frame>
  );
}

/** Tela bloqueada por inatividade: libera com PIN (ou senha, sem PIN) */
export function LockScreen() {
  const { user, setLocked, logout } = useAuth();
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await post('/api/auth/unlock', user?.hasPin ? { pin: secret } : { password: secret });
      setLocked(false);
    } catch (err) {
      setSecret('');
      setError(err instanceof ApiError ? err.message : 'Não foi possível desbloquear.');
    } finally { setBusy(false); }
  }
  return (
    <div className="fixed inset-0 z-[70] bg-bg/95 backdrop-blur-sm flex items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl bg-panel border border-line p-6 space-y-4 text-center">
        <div className="mx-auto size-14 rounded-2xl bg-panel-2 border border-line flex items-center justify-center"><Symbol size={30} /></div>
        <div>
          <h1 className="font-semibold text-ink flex items-center justify-center gap-2"><Lock className="size-4" /> Tela bloqueada</h1>
          <p className="text-sm text-ink-3 mt-1">{user?.name}, a tela foi bloqueada por falta de uso. {user?.hasPin ? 'Digite o seu PIN.' : 'Digite a sua senha.'}</p>
        </div>
        {error && <ErrorBox>{error}</ErrorBox>}
        <Input autoFocus type="password" inputMode={user?.hasPin ? 'numeric' : undefined} autoComplete={user?.hasPin ? 'off' : 'current-password'}
          value={secret} onChange={(e) => setSecret(e.target.value)} aria-label={user?.hasPin ? 'PIN' : 'Senha'} className="text-center text-lg h-12" />
        <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={!secret}>Desbloquear</Button>
        <button type="button" onClick={logout} className="inline-flex items-center gap-1.5 text-sm text-ink-3 hover:text-danger"><LogOut className="size-4" /> Sair</button>
      </form>
    </div>
  );
}
