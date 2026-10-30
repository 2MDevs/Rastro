import { FormEvent, useEffect, useRef, useState } from 'react';
import { Mail, Lock, Eye, EyeOff, ArrowRight, MapPin, Map as MapIcon, BarChart3, Users, ShieldCheck, ArrowLeft } from 'lucide-react';
import { ApiError, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Logo } from '../../brand/Logo';
import { Button, Checkbox, ErrorBox, Notice } from '../../components/ui';

/** Ilustração de fundo: malha de ruas estilizada (decorativa, sem dados) */
function StreetGrid() {
  return (
    <svg className="absolute inset-0 w-full h-full" viewBox="0 0 800 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <g stroke="#3A3A35" strokeWidth="1" fill="none" opacity="0.55">
        {Array.from({ length: 18 }).map((_, i) => <path key={`h${i}`} d={`M-50 ${60 + i * 52} L 900 ${20 + i * 52 + (i % 3) * 14}`} />)}
        {Array.from({ length: 16 }).map((_, i) => <path key={`v${i}`} d={`M${40 + i * 58} -40 L ${10 + i * 58 + (i % 4) * 10} 960`} />)}
      </g>
      <g stroke="#4A4A4A" strokeWidth="5" fill="none" opacity="0.5">
        <path d="M-40 640 C 200 600, 380 520, 860 300" />
        <path d="M120 -20 C 180 300, 260 620, 330 960" />
      </g>
    </svg>
  );
}

function Field({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 h-14 rounded-xl border border-[#34342F] bg-[#202020] px-4 focus-within:border-amarelo transition-colors">
      <span className="text-[#9C9A92]">{icon}</span>
      {children}
    </div>
  );
}

const inputCls = 'flex-1 bg-transparent text-white placeholder:text-[#8C8A82] text-[15px] outline-none';

export default function Login() {
  const { refresh } = useAuth();
  const [step, setStep] = useState<'login' | 'code' | 'forgot'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<any>(null);
  const [code, setCode] = useState('');
  const [trust, setTrust] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);
  useEffect(() => { if (step === 'code') codeRef.current?.focus(); }, [step]);

  const fail = (err: unknown) => setError(err instanceof ApiError ? err.message : 'Não foi possível entrar agora.');

  async function submitLogin(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setInfo(null);
    try {
      const r = await post('/api/auth/login', { email, password });
      if (r.require2FA) {
        setChallenge(r);
        setResendIn(r.resendAfterSeconds ?? 60);
        setCode('');
        setStep('code');
      } else {
        await refresh();
      }
    } catch (err) { fail(err); } finally { setBusy(false); }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await post('/api/auth/verify-2fa', { challengeToken: challenge.challengeToken, code, trustDevice: trust });
      await refresh();
    } catch (err) {
      fail(err);
      if (err instanceof ApiError && err.code === 'CODE_INVALIDATED') { setStep('login'); setPassword(''); }
    } finally { setBusy(false); }
  }

  async function resend() {
    setError(null);
    try {
      const r = await post('/api/auth/resend-2fa', { challengeToken: challenge.challengeToken });
      setResendIn(r.resendAfterSeconds ?? 60);
      setInfo(`Enviamos um novo código para ${r.maskedEmail}.`);
    } catch (err) { fail(err); }
  }

  async function submitForgot(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await post('/api/auth/forgot-password', { email });
      setInfo(r.message);
      setStep('login');
    } catch (err) { fail(err); } finally { setBusy(false); }
  }

  return (
    <div className="min-h-full grid lg:grid-cols-[1.15fr_1fr] bg-[#141413] text-white" data-theme="dark">
      {/* Lado da marca */}
      <section className="relative hidden lg:flex flex-col justify-between overflow-hidden p-14 bg-[#161615]">
        <StreetGrid />
        <div className="relative"><Logo height={64} tagline className="text-white" /></div>
        <div className="relative max-w-md">
          <h1 className="text-[34px] leading-tight font-medium">Mais controle para cada passo da sua <span className="text-amarelo">operação.</span></h1>
          <p className="mt-4 text-[#B9B6AA] leading-relaxed">Planeje territórios, acompanhe percursos realizados e transforme o deslocamento das equipes externas em cobertura estimada.</p>
        </div>
        <ul className="relative grid grid-cols-4 gap-0 max-w-xl text-sm text-[#D8D5CB]">
          {[
            { i: <MapPin className="size-6 text-amarelo" />, t: 'Rastreamento em campo' },
            { i: <MapIcon className="size-6 text-amarelo" />, t: 'Gestão territorial' },
            { i: <BarChart3 className="size-6 text-amarelo" />, t: 'Análise de cobertura' },
            { i: <Users className="size-6 text-amarelo" />, t: 'Equipes externas' },
          ].map((f, idx) => (
            <li key={f.t} className={`px-4 ${idx ? 'border-l border-[#34342F]' : 'pl-0'}`}>{f.i}<div className="mt-2 leading-snug">{f.t}</div></li>
          ))}
        </ul>
      </section>

      {/* Formulário */}
      <section className="relative flex flex-col justify-center px-6 sm:px-14 py-12 border-l border-[#262624]">
        <div className="absolute top-8 right-8 hidden sm:flex items-center gap-2 text-xs text-[#8C8A82]"><span className="w-6 h-px bg-amarelo" /> RASTRO · Gestão Hummm</div>
        <div className="w-full max-w-md mx-auto">
          <p className="text-[#D8D5CB] text-lg">Bem-vindo(a) ao</p>
          <Logo height={58} tagline className="text-white mt-1" />

          {step === 'login' && (
            <form onSubmit={submitLogin} className="mt-9 space-y-4" noValidate>
              <p className="text-[#B9B6AA] text-sm mb-6">Faça seu login para acessar o sistema e continuar sua operação.</p>
              {info && <Notice tone="ok">{info}</Notice>}
              {error && <ErrorBox>{error}</ErrorBox>}
              <Field icon={<Mail className="size-5" />}>
                <input className={inputCls} type="email" autoComplete="username" placeholder="E-mail" value={email} onChange={(e) => setEmail(e.target.value)} required aria-label="E-mail" />
              </Field>
              <Field icon={<Lock className="size-5" />}>
                <input className={inputCls} type={show ? 'text' : 'password'} autoComplete="current-password" placeholder="Senha" value={password} onChange={(e) => setPassword(e.target.value)} required aria-label="Senha" />
                <button type="button" onClick={() => setShow((s) => !s)} className="text-[#9C9A92] hover:text-white" aria-label={show ? 'Ocultar senha' : 'Mostrar senha'}>
                  {show ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
                </button>
              </Field>
              <Button type="submit" variant="primary" loading={busy} className="w-full h-14 text-base" disabled={!email || !password}>
                Entrar <ArrowRight className="size-5" />
              </Button>
              <div className="flex justify-end">
                <button type="button" onClick={() => { setStep('forgot'); setError(null); setInfo(null); }} className="text-sm text-[#D8D5CB] underline underline-offset-4 hover:text-amarelo">Esqueceu sua senha?</button>
              </div>
            </form>
          )}

          {step === 'code' && challenge && (
            <form onSubmit={submitCode} className="mt-9 space-y-4">
              <div className="flex items-start gap-3 text-sm text-[#D8D5CB]">
                <ShieldCheck className="size-5 text-amarelo shrink-0 mt-0.5" />
                <p>{challenge.firstAccess ? 'Primeiro acesso: ' : 'Dispositivo novo: '}enviamos um código de 6 números para <strong className="text-white">{challenge.maskedEmail}</strong>. Ele vale por {challenge.expiresInMinutes ?? 10} minutos.</p>
              </div>
              {info && <Notice tone="ok">{info}</Notice>}
              {error && <ErrorBox>{error}</ErrorBox>}
              <input ref={codeRef} inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
                className="w-full h-16 rounded-xl border border-[#34342F] bg-[#202020] text-center text-3xl tracking-[0.5em] font-semibold text-white outline-none focus:border-amarelo"
                aria-label="Código de verificação" placeholder="••••••" />
              <div className="rounded-xl border border-[#34342F] p-3">
                <Checkbox checked={trust} onChange={setTrust} label={<span className="text-white">Confiar neste dispositivo por 30 dias</span>}
                  description="Use só no seu computador ou celular. Em aparelhos compartilhados, deixe desmarcado." />
              </div>
              <Button type="submit" variant="primary" loading={busy} className="w-full h-14 text-base" disabled={code.length !== 6}>Confirmar código</Button>
              <div className="flex items-center justify-between text-sm">
                <button type="button" className="inline-flex items-center gap-1 text-[#B9B6AA] hover:text-white" onClick={() => { setStep('login'); setError(null); setInfo(null); }}><ArrowLeft className="size-4" /> Voltar</button>
                <button type="button" disabled={resendIn > 0} onClick={resend} className="text-[#D8D5CB] underline underline-offset-4 disabled:no-underline disabled:text-[#77746B]">
                  {resendIn > 0 ? `Reenviar em ${resendIn}s` : 'Reenviar código'}
                </button>
              </div>
            </form>
          )}

          {step === 'forgot' && (
            <form onSubmit={submitForgot} className="mt-9 space-y-4">
              <p className="text-[#B9B6AA] text-sm">Informe o seu e-mail. Se ele estiver cadastrado, você vai receber um link (válido por 30 minutos) para criar uma nova senha.</p>
              {error && <ErrorBox>{error}</ErrorBox>}
              <Field icon={<Mail className="size-5" />}>
                <input className={inputCls} type="email" autoComplete="username" placeholder="E-mail" value={email} onChange={(e) => setEmail(e.target.value)} required aria-label="E-mail" />
              </Field>
              <Button type="submit" variant="primary" loading={busy} className="w-full h-14 text-base" disabled={!email}>Enviar link</Button>
              <button type="button" className="inline-flex items-center gap-1 text-sm text-[#B9B6AA] hover:text-white" onClick={() => { setStep('login'); setError(null); }}><ArrowLeft className="size-4" /> Voltar ao login</button>
            </form>
          )}
        </div>
        <div className="absolute bottom-8 right-8 flex items-center gap-2 text-xs text-[#77746B]"><span className="w-6 h-px bg-amarelo" /> RASTRO</div>
      </section>
    </div>
  );
}
