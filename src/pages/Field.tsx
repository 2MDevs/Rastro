import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigation, Play, Square, Wifi, WifiOff, MapPin, AlertTriangle, Smartphone, CloudUpload, ShieldCheck, Download, BatteryWarning } from 'lucide-react';
import { ApiError, get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { relative } from '../lib/format';
import { addPoint, countFor, pendingFor, removePoints, sessionsWithPending, uuid } from '../lib/fieldQueue';
import { useToast } from '../components/toast';
import { isAndroidBrowser, nativeBridge, nativeInfo, nativeStatus, type NativeStatus } from '../lib/nativeApp';
import { Badge, Button, Card, EmptyState, ErrorBox, Notice, PageHeader, Spinner, useConfirm, cx } from '../components/ui';

const LOCAL_KEY = 'rastro-campo';
const MIN_INTERVAL_MS = 3000;
const MIN_MOVE_M = 4;

function readLocal(): { installId?: string; deviceId?: string; sessionId?: string; pendingFinish?: { sessionId: string; at: string } } {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}'); } catch { return {}; }
}
function writeLocal(patch: Record<string, unknown>) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify({ ...readLocal(), ...patch })); } catch { /* sem armazenamento */ }
}
const meters = (a: GeolocationCoordinates, b: { lat: number; lng: number }) => {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (a.latitude - b.lat) * toR, dLng = (a.longitude - b.lng) * toR;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(b.lat * toR) * Math.cos(a.latitude * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

export default function Field() {
  const { user } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(readLocal().deviceId ?? null);
  const [session, setSession] = useState<any>(null);
  const [tracking, setTracking] = useState(false);
  const [gps, setGps] = useState<{ accuracy: number | null; at: number | null; error: string | null }>({ accuracy: null, at: null, error: null });
  const [captured, setCaptured] = useState(0);
  const [pending, setPending] = useState(0);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [busy, setBusy] = useState(false);
  const [wakeLock, setWakeLock] = useState<'on' | 'off' | 'unsupported'>('off');
  const watchId = useRef<number | null>(null);
  const lastKept = useRef<{ lat: number; lng: number; t: number } | null>(null);
  const flushing = useRef(false);
  const wakeRef = useRef<any>(null);
  // Dentro do app Android o GPS roda num serviço do celular (continua com a tela apagada)
  const [native] = useState(() => nativeBridge());
  const [nst, setNst] = useState<NativeStatus | null>(null);

  const load = useCallback(async () => {
    try { setData(await get('/api/tracking/my-campaigns')); setError(null); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Não foi possível carregar.'); }
  }, []);

  // Registro do aparelho (uma vez por navegador)
  useEffect(() => {
    (async () => {
      const app = nativeInfo();
      let { installId } = readLocal();
      if (!installId) { installId = uuid() + uuid(); writeLocal({ installId }); }
      const body = app?.installId
        ? { kind: 'ANDROID_APP', installId: app.installId, name: app.device || 'Celular Android', appVersion: app.version }
        : { kind: 'WEB_FIELD', installId, name: `Navegador de ${user?.name?.split(' ')[0] ?? 'campo'}`, appVersion: 'web' };
      try {
        const r = await post('/api/tracking/devices/register', body);
        setDeviceId(r.id); writeLocal({ deviceId: r.id });
      } catch (err) { setError(err instanceof ApiError ? err.message : 'Não foi possível registrar este aparelho.'); }
      load();
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const on = () => { setOnline(true); flush(); };
    const off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // Envio em lotes: tenta a cada 10 s e sempre que a internet volta
  const flush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      const sessions = await sessionsWithPending();
      for (const sid of sessions) {
        for (;;) {
          const batch = await pendingFor(sid, 200);
          if (!batch.length) break;
          const remaining = (await countFor(sid)) - batch.length;
          await post(`/api/tracking/sessions/${sid}/points`, {
            points: batch.map(({ sessionId: _s, ...p }) => p),
            pendingPoints: remaining > 0 ? remaining : 0,
          });
          await removePoints(batch.map((p) => p.id));
          setLastSync(Date.now());
        }
      }
      // Encerramento que ficou para depois (estava sem internet)
      const pf = readLocal().pendingFinish;
      if (pf) {
        await post(`/api/tracking/sessions/${pf.sessionId}/finish`, { reason: 'USER', finishedAt: pf.at, pendingPoints: 0 });
        writeLocal({ pendingFinish: undefined });
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setGps((g) => ({ ...g, error: err.message }));
    } finally {
      flushing.current = false;
      const sid = readLocal().sessionId;
      if (sid && !nativeBridge()) setPending(await countFor(sid));
    }
  }, []);
  useEffect(() => { const t = setInterval(flush, 10_000); flush(); return () => clearInterval(t); }, [flush]);

  // App Android: lê o estado do serviço de rastreamento a cada 2 s
  useEffect(() => {
    if (!native) return;
    const tick = () => {
      const st = nativeStatus();
      if (!st) return;
      setNst(st);
      const sid = session?.id;
      setTracking(!!sid && st.tracking && st.sessionId === sid);
      setPending(st.pending);
      if (st.lastSyncAt) setLastSync(st.lastSyncAt);
      setGps({
        accuracy: st.accuracy >= 0 ? st.accuracy : null,
        at: st.lastFixAt || null,
        error: st.lastError || (!st.permission ? 'O app está sem permissão de localização. Toque em "Abrir configurações do app" e permita a localização o tempo todo.' : (!st.gpsEnabled ? 'A localização (GPS) do celular está desligada.' : null)),
      });
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => clearInterval(t);
  }, [native, session?.id]);

  // Sessão aberta no servidor (ex.: a página foi recarregada no meio da operação)
  useEffect(() => {
    if (data?.openSession && !session) setSession(data.openSession);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  async function keepScreenOn() {
    try {
      if (!('wakeLock' in navigator)) { setWakeLock('unsupported'); return; }
      wakeRef.current = await (navigator as any).wakeLock.request('screen');
      setWakeLock('on');
      wakeRef.current.addEventListener?.('release', () => setWakeLock('off'));
    } catch { setWakeLock('off'); }
  }
  useEffect(() => {
    const vis = () => { if (document.visibilityState === 'visible' && tracking) keepScreenOn(); };
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  }, [tracking]); // eslint-disable-line react-hooks/exhaustive-deps

  function startWatch(sessionId: string) {
    if (!('geolocation' in navigator)) { setGps((g) => ({ ...g, error: 'Este navegador não tem GPS disponível.' })); return; }
    (window as any).__rastroTrackingActive = true;
    setTracking(true);
    keepScreenOn();
    watchId.current = navigator.geolocation.watchPosition(async (pos) => {
      const c = pos.coords;
      setGps({ accuracy: c.accuracy ?? null, at: pos.timestamp, error: null });
      const last = lastKept.current;
      if (last && pos.timestamp - last.t < MIN_INTERVAL_MS && meters(c, last) < MIN_MOVE_M) return;
      lastKept.current = { lat: c.latitude, lng: c.longitude, t: pos.timestamp };
      await addPoint({
        id: uuid(), sessionId, lat: c.latitude, lng: c.longitude, accuracy: c.accuracy ?? null, altitude: c.altitude ?? null,
        speed: c.speed ?? null, heading: c.heading ?? null, capturedAt: new Date(pos.timestamp).toISOString(),
      });
      setCaptured((n) => n + 1);
      setPending(await countFor(sessionId));
    }, (err) => {
      const msg = err.code === err.PERMISSION_DENIED
        ? 'O acesso à localização foi negado. Libere a localização para este site nas configurações do navegador.'
        : err.code === err.POSITION_UNAVAILABLE ? 'Sem sinal de GPS no momento. Vá para um local mais aberto.' : 'O GPS demorou para responder. Tentando de novo...';
      setGps((g) => ({ ...g, error: msg }));
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 });
  }

  /** Liga o rastreamento: no app, pelo serviço do Android; no navegador, pelo GPS da página */
  function beginTracking(sessionId: string) {
    if (!native) { startWatch(sessionId); return; }
    const ok = native.start(sessionId);
    if (!ok) {
      setGps((g) => ({ ...g, error: 'Permita a localização para o RASTRO (de preferência "o tempo todo") e toque em "Continuar rastreamento".' }));
      return;
    }
    setTracking(true);
  }

  function stopWatch() {
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
    (window as any).__rastroTrackingActive = false;
    setTracking(false);
    wakeRef.current?.release?.().catch?.(() => {});
    wakeRef.current = null;
  }
  useEffect(() => () => stopWatch(), []); // eslint-disable-line react-hooks/exhaustive-deps

  async function start(campaign: any) {
    if (!deviceId) return;
    const ok = await confirm.ask('Iniciar rastreamento',
      <div className="space-y-2">
        <p>A sua localização vai ser registrada <strong>só enquanto este rastreamento estiver ativo</strong>, para acompanhar o percurso da campanha <strong>{campaign.name}</strong>.</p>
        {native
          ? <p>Pode apagar a tela e guardar o celular no bolso: o app continua registrando e mostra uma notificação enquanto estiver rastreando.</p>
          : <p>Mantenha esta tela aberta e o celular desbloqueado. Se você trocar de aplicativo ou a tela apagar, o navegador pode parar o GPS.</p>}
      </div>, 'Iniciar');
    if (!ok) return;
    setBusy(true);
    try {
      const s = await post('/api/tracking/sessions', { clientSessionId: uuid(), campaignId: campaign.id, trackerDeviceId: deviceId, startedAt: new Date().toISOString() });
      setSession(s); writeLocal({ sessionId: s.id }); setCaptured(0); lastKept.current = null;
      beginTracking(s.id);
      toast('ok', 'Rastreamento iniciado.');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SESSION_OPEN') await load();
      toast('error', err instanceof ApiError ? err.message : 'Não foi possível iniciar.');
    } finally { setBusy(false); }
  }

  async function finish() {
    if (!session) return;
    const ok = await confirm.ask('Encerrar rastreamento', 'Encerrar o rastreamento agora? Os pontos que ainda não foram enviados continuam guardados neste aparelho e são enviados quando houver internet.', 'Encerrar');
    if (!ok) return;
    setBusy(true);
    const at = new Date().toISOString();
    let left: number;
    if (native) {
      // O app para o GPS e continua enviando sozinho o que faltou
      left = native.stop();
      setTracking(false);
    } else {
      stopWatch();
      await flush();
      left = await countFor(session.id);
    }
    try {
      await post(`/api/tracking/sessions/${session.id}/finish`, { reason: 'USER', finishedAt: at, pendingPoints: left });
      toast('ok', left ? `Rastreamento encerrado. ${left} ponto(s) serão enviados quando houver internet.` : 'Rastreamento encerrado e todos os pontos enviados.');
    } catch {
      writeLocal({ pendingFinish: { sessionId: session.id, at } });
      toast('info', 'Sem internet: o encerramento será enviado automaticamente quando a conexão voltar.');
    }
    writeLocal({ sessionId: undefined });
    setSession(null);
    setBusy(false);
    load();
  }

  if (error && !data) return <ErrorBox onRetry={load}>{error}</ErrorBox>;
  if (!data) return <Spinner />;
  const camps: any[] = data.campaigns;
  const gpsAge = gps.at ? (Date.now() - gps.at) / 1000 : null;

  return (
    <div className="max-w-xl mx-auto">
      {confirm.element}
      <PageHeader title="Modo campo" subtitle="Registro do percurso durante a panfletagem" />
      {error && <div className="mb-4"><ErrorBox>{error}</ErrorBox></div>}

      {session ? (
        <div className="space-y-4">
          <Card>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs text-ink-3">Campanha</div>
                <div className="font-semibold text-ink">{session.campaignName}</div>
                <div className="text-xs text-ink-3">{session.storeName}</div>
              </div>
              <Badge tone={tracking ? 'info' : 'warn'}>{tracking ? 'Rastreando' : 'Parado neste aparelho'}</Badge>
            </div>
            <div className={cx('mt-5 rounded-2xl border p-5 text-center', tracking ? 'border-info/40 bg-info/8' : 'border-warn/40 bg-warn/8')}>
              <Navigation className={cx('size-8 mx-auto', tracking ? 'text-info' : 'text-warn')} />
              <div className="mt-2 text-sm text-ink">{tracking ? 'Sua localização está sendo registrada.' : 'O rastreamento deste aparelho está parado.'}</div>
              {tracking && <div className="text-xs text-ink-3 mt-1">Precisão atual: {gps.accuracy !== null ? `± ${Math.round(gps.accuracy)} m` : 'aguardando GPS'}{gpsAge !== null && gpsAge > 30 ? ` · último sinal há ${Math.round(gpsAge)} s` : ''}</div>}
            </div>
            {gps.error && <div className="mt-3"><Notice tone="warn" icon={<AlertTriangle className="size-4" />}>{gps.error}</Notice></div>}
            {!tracking && <Button variant="primary" className="w-full mt-4 h-12" icon={<Play className="size-5" />} onClick={() => beginTracking(session.id)}>Continuar rastreamento neste aparelho</Button>}
            <div className="grid grid-cols-3 gap-3 mt-4 text-center">
              <div className="rounded-xl bg-panel-2 border border-line p-3">{native
                ? <><div className="text-sm font-semibold">{gps.at ? relative(new Date(gps.at)) : '—'}</div><div className="text-[11px] text-ink-3">último sinal de GPS</div></>
                : <><div className="text-lg font-semibold tabular">{captured}</div><div className="text-[11px] text-ink-3">pontos registrados</div></>}</div>
              <div className="rounded-xl bg-panel-2 border border-line p-3"><div className="text-lg font-semibold tabular">{pending}</div><div className="text-[11px] text-ink-3">aguardando envio</div></div>
              <div className="rounded-xl bg-panel-2 border border-line p-3"><div className="text-sm font-semibold">{lastSync ? relative(new Date(lastSync)) : '—'}</div><div className="text-[11px] text-ink-3">último envio</div></div>
            </div>
            <div className="flex items-center gap-2 mt-3 text-xs">
              {online ? <><Wifi className="size-3.5 text-ok" /><span className="text-ink-3">Com internet: os pontos são enviados a cada 10 segundos.</span></>
                : <><WifiOff className="size-3.5 text-warn" /><span className="text-warn">Sem internet: os pontos ficam guardados neste aparelho e são enviados depois.</span></>}
            </div>
            <Button variant="danger" className="w-full mt-5 h-12" icon={<Square className="size-5" />} loading={busy} onClick={finish}>Encerrar rastreamento</Button>
          </Card>
          {native ? (
            <>
              <Notice tone="info" icon={<Smartphone className="size-4" />}>
                Você pode apagar a tela e guardar o celular: o app do RASTRO continua registrando o percurso e mostra uma notificação enquanto rastreia. Só não feche o app pela lista de aplicativos abertos.
              </Notice>
              {nst?.batteryOptimized && (
                <Notice tone="warn" icon={<BatteryWarning className="size-4" />}>
                  <div>O modo de economia de bateria pode pausar o GPS em alguns celulares.</div>
                  <Button className="mt-2" onClick={() => native.requestBatteryExemption()}>Permitir uso sem restrição de bateria</Button>
                </Notice>
              )}
              {nst && (!nst.permission || !nst.gpsEnabled) && (
                <div className="flex flex-wrap gap-2">
                  {!nst.permission && <Button onClick={() => native.openAppSettings()}>Abrir configurações do app</Button>}
                  {!nst.gpsEnabled && <Button onClick={() => native.openLocationSettings()}>Ligar a localização</Button>}
                </div>
              )}
            </>
          ) : (
          <Notice tone="info" icon={<Smartphone className="size-4" />}>
            {wakeLock === 'on' ? 'A tela vai continuar acesa enquanto esta página estiver aberta.' : 'Mantenha a tela acesa e esta página aberta.'} Se a tela apagar ou você mudar de aplicativo, o navegador pode pausar o GPS: ao voltar, toque em "Continuar rastreamento". {isAndroidBrowser() && <>Para rastrear com a tela apagada, use o <a className="underline font-medium" href="/app">aplicativo Android do RASTRO</a>.</>}
          </Notice>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <Notice tone="info" icon={<ShieldCheck className="size-4" />}>
            O RASTRO só registra a sua localização <strong>depois que você toca em "Iniciar"</strong> e para quando você encerra. Nada é coletado fora do rastreamento.
          </Notice>
          {isAndroidBrowser() && (
            <Notice tone="warn" icon={<Download className="size-4" />}>
              <div><strong>Use o aplicativo do RASTRO.</strong> Pelo navegador, o GPS para quando a tela apaga. O app continua registrando com o celular no bolso.</div>
              <a href="/app" className="inline-block mt-2 font-semibold underline">Baixar o app Android</a>
            </Notice>
          )}
          {pending > 0 && <Notice tone="warn" icon={<CloudUpload className="size-4" />}>Há pontos de um rastreamento anterior guardados neste aparelho. Eles serão enviados assim que houver internet.</Notice>}
          <Card title="Suas campanhas" padded={false}>
            {camps.length ? (
              <ul className="divide-y divide-line">
                {camps.map((c) => (
                  <li key={c.id} className="px-5 py-4 flex items-center gap-3">
                    <MapPin className="size-5 text-accent-ink shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-ink truncate">{c.name}</div>
                      <div className="text-xs text-ink-3">{c.store.name} · {c.streets} rua(s) planejada(s)</div>
                      {!c.canTrack && <div className="text-xs text-warn mt-0.5">{c.status === 'PAUSED' ? 'Campanha pausada' : 'Campanha ainda não ativada'}</div>}
                    </div>
                    <Button variant="primary" icon={<Play className="size-4" />} disabled={!c.canTrack || !deviceId} loading={busy} onClick={() => start(c)}>Iniciar</Button>
                  </li>
                ))}
              </ul>
            ) : <EmptyState icon={<Navigation className="size-5" />} title="Nenhuma campanha para você">Quando você for escolhido como responsável por uma campanha ativa, ela aparece aqui.</EmptyState>}
          </Card>
        </div>
      )}
    </div>
  );
}
