import { useEffect, useRef, useState } from 'react';
import { Crosshair, Smartphone, DoorOpen, ShieldCheck, RotateCcw, Check, AlertTriangle, Loader2 } from 'lucide-react';
import { ApiError, put } from '../lib/api';
import type { Store } from '../lib/types';
import { MapView } from './map/MapView';
import { useToast } from './toast';
import { Badge, Button, Checkbox, ErrorBox, Modal, Notice } from './ui';

/**
 * Registro da localização da loja pelo GPS do aparelho, feito DENTRO da loja.
 * Coleta leituras por até 30 segundos e guarda a mais precisa. Acima de 100 m não deixa salvar.
 */
const MAX_SECONDS = 30;
const GOOD_M = 20;
const MAX_ACCEPT_M = 100;

type Reading = { lat: number; lng: number; accuracy: number; at: number };

function quality(acc: number) {
  if (acc <= GOOD_M) return { tone: 'ok' as const, label: 'Ótima precisão' };
  if (acc <= 50) return { tone: 'yellow' as const, label: 'Boa precisão' };
  if (acc <= MAX_ACCEPT_M) return { tone: 'warn' as const, label: 'Precisão baixa' };
  return { tone: 'danger' as const, label: 'Imprecisa demais' };
}

export function StoreLocationCapture({ store, open, onClose, onSaved }: { store: Store; open: boolean; onClose: () => void; onSaved: (s: Store) => void }) {
  const toast = useToast();
  const [phase, setPhase] = useState<'intro' | 'capturing' | 'review'>('intro');
  const [best, setBest] = useState<Reading | null>(null);
  const [current, setCurrent] = useState<number | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [inside, setInside] = useState(false);
  const [saving, setSaving] = useState(false);
  const watchId = useRef<number | null>(null);
  const timer = useRef<number | null>(null);
  const bestRef = useRef<Reading | null>(null);

  const stop = () => {
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
    if (timer.current !== null) window.clearInterval(timer.current);
    watchId.current = null;
    timer.current = null;
  };
  useEffect(() => () => stop(), []);
  useEffect(() => {
    if (!open) { stop(); setPhase('intro'); setBest(null); bestRef.current = null; setCurrent(null); setError(null); setInside(false); setSeconds(0); }
  }, [open]);

  function finish() {
    stop();
    if (bestRef.current) setPhase('review');
    else { setPhase('intro'); setError('Não foi possível obter a localização. Confira se a localização do aparelho está ligada e tente de novo.'); }
  }

  function start() {
    setError(null);
    if (!window.isSecureContext) { setError('A localização só funciona com o endereço seguro (https).'); return; }
    if (!('geolocation' in navigator)) { setError('Este navegador não oferece localização. Use o celular.'); return; }
    setBest(null); bestRef.current = null; setCurrent(null); setSeconds(0); setInside(false);
    setPhase('capturing');
    const startedAt = Date.now();
    timer.current = window.setInterval(() => {
      const s = Math.round((Date.now() - startedAt) / 1000);
      setSeconds(s);
      if (s >= MAX_SECONDS) finish();
    }, 500);
    watchId.current = navigator.geolocation.watchPosition((pos) => {
      const r: Reading = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, at: pos.timestamp };
      setCurrent(r.accuracy);
      if (!bestRef.current || r.accuracy < bestRef.current.accuracy) { bestRef.current = r; setBest(r); }
      // Precisão ótima e já com alguns segundos de leitura: pode encerrar antes
      if (r.accuracy <= GOOD_M && Date.now() - startedAt > 6000) finish();
    }, (err) => {
      stop();
      setPhase('intro');
      setError(err.code === err.PERMISSION_DENIED
        ? 'O acesso à localização foi negado. Libere a localização para este site nas configurações do navegador e tente de novo.'
        : 'Não foi possível obter a localização. Ligue a localização do aparelho (modo de alta precisão) e tente de novo.');
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 });
  }

  async function save() {
    if (!best) return;
    setSaving(true); setError(null);
    try {
      const s = await put<Store>(`/api/stores/${store.id}/location`, {
        lat: best.lat, lng: best.lng, accuracyM: best.accuracy, capturedAt: new Date(best.at).toISOString(), insideStore: true,
      });
      toast('ok', 'Localização da loja registrada.');
      onSaved(s);
      onClose();
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.'); } finally { setSaving(false); }
  }

  const q = best ? quality(best.accuracy) : null;

  return (
    <Modal open={open} onClose={phase === 'capturing' ? undefined : onClose} title={`Localização da loja · ${store.name}`}
      footer={phase === 'intro' ? <><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" icon={<Crosshair className="size-4" />} onClick={start}>Estou dentro da loja · capturar</Button></>
        : phase === 'capturing' ? <Button variant="secondary" onClick={finish} disabled={!best}>Usar a melhor leitura agora</Button>
        : <><Button variant="ghost" icon={<RotateCcw className="size-4" />} onClick={start}>Capturar de novo</Button>
            <Button variant="primary" icon={<Check className="size-4" />} loading={saving} onClick={save} disabled={!inside || !best || best.accuracy > MAX_ACCEPT_M}>Salvar localização</Button></>}>
      <div className="space-y-4 text-sm">
        {error && <ErrorBox>{error}</ErrorBox>}

        {phase === 'intro' && (
          <>
            <Notice tone="warn" icon={<DoorOpen className="size-4" />}>
              <strong className="text-ink">Faça este registro dentro da loja.</strong> A localização usada é a do aparelho neste momento: se você estiver em outro lugar, a loja vai aparecer no lugar errado no mapa.
            </Notice>
            <ul className="space-y-2 text-ink-2">
              <li className="flex gap-2"><Smartphone className="size-4 text-accent-ink shrink-0 mt-0.5" /> Use o <strong className="text-ink">celular</strong> (tem GPS). Computador costuma errar por centenas de metros.</li>
              <li className="flex gap-2"><Crosshair className="size-4 text-accent-ink shrink-0 mt-0.5" /> Ligue a localização do aparelho no modo de <strong className="text-ink">alta precisão</strong> e permita o acesso quando o navegador pedir.</li>
              <li className="flex gap-2"><DoorOpen className="size-4 text-accent-ink shrink-0 mt-0.5" /> Fique perto da <strong className="text-ink">porta ou do balcão da frente</strong>. Longe de paredes grossas o sinal melhora.</li>
              <li className="flex gap-2"><ShieldCheck className="size-4 text-accent-ink shrink-0 mt-0.5" /> A localização é lida só agora, para posicionar a loja. Nada é rastreado depois.</li>
            </ul>
            {store.location && <p className="text-xs text-ink-3">A loja já tem uma localização registrada. Ao salvar, a nova substitui a anterior (fica registrado na auditoria).</p>}
          </>
        )}

        {phase === 'capturing' && (
          <div className="text-center py-4 space-y-3">
            <Loader2 className="size-8 mx-auto animate-spin text-accent-ink" />
            <p className="text-ink">Lendo o GPS... fique parado dentro da loja.</p>
            <p className="text-ink-3 tabular">{seconds}s de {MAX_SECONDS}s · precisão atual: {current === null ? 'aguardando sinal' : `± ${Math.round(current)} m`}</p>
            {best && <p className="text-xs text-ink-3">Melhor leitura até agora: ± {Math.round(best.accuracy)} m</p>}
          </div>
        )}

        {phase === 'review' && best && q && (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="text-ink">Precisão: <strong>± {Math.round(best.accuracy)} m</strong></span>
              <Badge tone={q.tone}>{q.label}</Badge>
            </div>
            <div className="rounded-xl overflow-hidden border border-line">
              <MapView className="h-56" pickMarker={{ lat: best.lat, lng: best.lng }} focus={{ center: { lat: best.lat, lng: best.lng }, zoom: 17, key: best.at }} visible={{ stores: false }} />
            </div>
            <p className="text-xs text-ink-3">Confira se o marcador amarelo está em cima da loja.</p>
            {best.accuracy > MAX_ACCEPT_M ? (
              <Notice tone="warn" icon={<AlertTriangle className="size-4" />}>A precisão passou de {MAX_ACCEPT_M} m e não pode ser usada. Vá para perto da porta, confira se a localização precisa está ligada e capture de novo.</Notice>
            ) : (
              <div className="rounded-xl border border-line p-3">
                <Checkbox checked={inside} onChange={setInside} label="Confirmo que estou dentro da loja agora" description="Obrigatório para salvar. Fica registrado quem salvou, quando e com qual precisão." />
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
