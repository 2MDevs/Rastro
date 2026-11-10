import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Share, PlusSquare, X } from 'lucide-react';
import { Symbol } from '../brand/Logo';

/**
 * iPhone/iPad: não existe APK, então o RASTRO pode ser instalado como app pela tela de início (PWA).
 * O iPhone não mostra aviso sozinho, por isso mostramos as instruções.
 * Android: o app oficial é o APK (página /app); lá não oferecemos a instalação pelo navegador.
 */
const KEY = 'rastro-ios-instalar-depois';
const SNOOZE_DAYS = 7;

export function isIos() {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPad novo
}
export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
}
/** Navegadores dentro de outros apps (Instagram, WhatsApp, Facebook) não deixam instalar */
const inAppBrowser = () => /FBAN|FBAV|Instagram|Line\/|WhatsApp|GSA\//i.test(navigator.userAgent);

export function IosInstallBanner() {
  const loc = useLocation();
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!isIos() || isStandalone() || loc.pathname === '/app') { setShow(false); return; }
    let until = 0;
    try { until = Number(localStorage.getItem(KEY) || 0); } catch { /* sem armazenamento */ }
    setShow(Date.now() > until);
  }, [loc.pathname]);
  if (!show) return null;
  const later = () => {
    try { localStorage.setItem(KEY, String(Date.now() + SNOOZE_DAYS * 86_400_000)); } catch { /* ok */ }
    setShow(false);
  };
  return (
    <div className="fixed inset-x-0 bottom-0 z-[60] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] no-print" role="dialog" aria-label="Instalar o RASTRO no iPhone">
      <div className="mx-auto max-w-md rounded-2xl border border-line bg-panel shadow-2xl p-4">
        <div className="flex items-start gap-3">
          <div className="size-11 shrink-0 rounded-xl bg-grafite flex items-center justify-center"><Symbol size={26} /></div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-ink">Instale o RASTRO no seu iPhone</div>
            <div className="text-xs text-ink-3 mt-0.5">Abre direto da tela de início, em tela cheia, como um aplicativo.</div>
          </div>
          <button onClick={later} aria-label="Fechar" className="size-8 -mr-1 -mt-1 rounded-lg flex items-center justify-center text-ink-3 hover:bg-panel-2"><X className="size-4" /></button>
        </div>
        {inAppBrowser() ? (
          <p className="mt-3 text-xs text-ink-2">Este link abriu dentro de outro aplicativo. Toque nos <strong>três pontinhos</strong> e escolha <strong>Abrir no Safari</strong>; depois siga as instruções.</p>
        ) : (
          <ol className="mt-3 space-y-2 text-sm text-ink-2">
            <li className="flex items-center gap-2"><span className="size-6 shrink-0 rounded-full bg-amarelo text-grafite text-xs font-bold flex items-center justify-center">1</span>
              Toque em <Share className="size-4 text-info shrink-0" aria-label="Compartilhar" /> <strong>Compartilhar</strong> (na barra do navegador)</li>
            <li className="flex items-center gap-2"><span className="size-6 shrink-0 rounded-full bg-amarelo text-grafite text-xs font-bold flex items-center justify-center">2</span>
              Escolha <PlusSquare className="size-4 shrink-0" aria-hidden /> <strong>Adicionar à Tela de Início</strong></li>
            <li className="flex items-center gap-2"><span className="size-6 shrink-0 rounded-full bg-amarelo text-grafite text-xs font-bold flex items-center justify-center">3</span>
              Toque em <strong>Adicionar</strong> e abra o RASTRO pelo ícone</li>
          </ol>
        )}
        <p className="mt-3 text-[11px] text-ink-3">No iPhone, mantenha a tela do RASTRO aberta durante o rastreamento: o iOS pausa o GPS quando a tela apaga.</p>
        <button onClick={later} className="mt-2 w-full h-9 rounded-xl text-xs text-ink-3 hover:text-ink">Agora não</button>
      </div>
    </div>
  );
}

/** Android: não oferece instalar pelo navegador (o app oficial é o APK) */
export function blockAndroidPwaPrompt() {
  if (!/Android/i.test(navigator.userAgent)) return;
  window.addEventListener('beforeinstallprompt', (e) => e.preventDefault());
}
