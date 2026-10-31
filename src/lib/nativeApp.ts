// Ponte com o aplicativo Android do RASTRO (existe só quando o site está aberto dentro do app)

export interface NativeInfo { app: boolean; version: string; installId: string; device: string }
export interface NativeStatus {
  tracking: boolean;
  sessionId: string | null;
  pending: number;
  lastFixAt: number;
  accuracy: number;
  lastSyncAt: number;
  lastError: string;
  permission: boolean;
  gpsEnabled: boolean;
  batteryOptimized: boolean;
}
interface Bridge {
  info(): string;
  start(sessionId: string): boolean;
  stop(): number;
  status(): string;
  openAppSettings(): void;
  openLocationSettings(): void;
  requestBatteryExemption(): void;
}

export function nativeBridge(): Bridge | null {
  const b = (window as any).RastroApp;
  return b && typeof b.start === 'function' ? (b as Bridge) : null;
}
export function nativeInfo(): NativeInfo | null {
  const b = nativeBridge();
  if (!b) return null;
  try { return JSON.parse(b.info()); } catch { return null; }
}
export function nativeStatus(): NativeStatus | null {
  const b = nativeBridge();
  if (!b) return null;
  try { return JSON.parse(b.status()); } catch { return null; }
}

export const isAndroidBrowser = () => /Android/i.test(navigator.userAgent) && !nativeBridge();

/** Endereço público da página de download do app */
export const appPageUrl = () => `${window.location.origin}/app`;
export const apkUrl = () => `${window.location.origin}/app/rastro.apk`;

export function appShareText(name?: string) {
  const hi = name ? `Olá, ${name.split(' ')[0]}! ` : 'Olá! ';
  return `${hi}Baixe o aplicativo do RASTRO no seu celular Android para registrar o percurso da panfletagem: ${appPageUrl()}\nDepois de instalar, entre com o seu e-mail e senha do RASTRO.`;
}

export function whatsappLink(name?: string, phone?: string | null) {
  const digits = (phone ?? '').replace(/\D/g, '');
  const to = digits ? (digits.length <= 11 ? `55${digits}` : digits) : '';
  return `https://wa.me/${to}?text=${encodeURIComponent(appShareText(name))}`;
}

/** Abre o compartilhamento do celular; no computador (ou se não houver), abre o WhatsApp */
export async function shareApp(name?: string, phone?: string | null): Promise<'shared' | 'whatsapp' | 'cancelled'> {
  if (!phone && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: 'App RASTRO', text: appShareText(name) });
      return 'shared';
    } catch (err: any) {
      if (err?.name === 'AbortError') return 'cancelled';
    }
  }
  // Dentro do app, o link é aberto fora (no WhatsApp) pelo próprio Android
  if (nativeBridge()) window.location.href = whatsappLink(name, phone);
  else window.open(whatsappLink(name, phone), '_blank', 'noopener');
  return 'whatsapp';
}
