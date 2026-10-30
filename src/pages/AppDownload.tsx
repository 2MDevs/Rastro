import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Share2, Smartphone, ShieldCheck, BatteryCharging, MapPin } from 'lucide-react';
import { Frame } from './auth/AccessScreens';
import { Button, Notice } from '../components/ui';
import { apkUrl, nativeBridge, shareApp } from '../lib/nativeApp';

/** Página pública (sem login) para o divulgador baixar o app Android */
export default function AppDownload() {
  const android = /Android/i.test(navigator.userAgent);
  const inApp = !!nativeBridge();
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <Frame>
      <div className="space-y-5">
        <div className="text-center">
          <div className="mx-auto size-14 rounded-2xl bg-amarelo text-grafite flex items-center justify-center"><Smartphone className="size-7" /></div>
          <h1 className="mt-3 text-lg font-semibold text-ink">App RASTRO para Android</h1>
          <p className="text-sm text-ink-3 mt-1">Registra o percurso da panfletagem mesmo com a tela apagada e o celular no bolso.</p>
        </div>

        {inApp ? (
          <Notice tone="ok">Você já está usando o app do RASTRO.</Notice>
        ) : (
          <a href={apkUrl()} className="block"><Button variant="primary" className="w-full h-12" icon={<Download className="size-5" />}>Baixar o app (Android)</Button></a>
        )}
        {!android && !inApp && <Notice tone="info">O app é para celulares Android. Abra esta página no celular do divulgador ou envie o link para ele.</Notice>}

        <Button className="w-full" icon={<Share2 className="size-4" />} onClick={async () => {
          const r = await shareApp();
          if (r === 'whatsapp') setMsg('Escolha a conversa no WhatsApp e envie.');
        }}>Enviar o link para outra pessoa</Button>
        {msg && <p className="text-xs text-ink-3 text-center">{msg}</p>}

        <div className="rounded-xl border border-line bg-panel-2 p-4">
          <div className="text-sm font-semibold text-ink mb-2">Como instalar</div>
          <ol className="list-decimal pl-5 space-y-1.5 text-sm text-ink-2">
            <li>Toque em <strong>Baixar o app</strong> e espere o download terminar.</li>
            <li>Abra o arquivo <strong>rastro.apk</strong>. Se o celular avisar, toque em <strong>Configurações</strong> e ative <strong>Permitir desta fonte</strong>; depois volte e toque em <strong>Instalar</strong>.</li>
            <li>Abra o RASTRO e entre com o seu e-mail e senha.</li>
            <li>Quando pedir, permita a <strong>localização</strong> (de preferência <strong>"o tempo todo"</strong>) e as <strong>notificações</strong>.</li>
            <li>No Modo campo, toque em <strong>Iniciar</strong> na sua campanha e pode guardar o celular.</li>
          </ol>
        </div>

        <ul className="space-y-2 text-xs text-ink-3">
          <li className="flex gap-2"><ShieldCheck className="size-4 shrink-0 text-ok" />A localização só é registrada depois que você toca em "Iniciar" e para quando você encerra. Enquanto rastreia, aparece uma notificação.</li>
          <li className="flex gap-2"><BatteryCharging className="size-4 shrink-0 text-info" />Se o celular economizar bateria demais, o app mostra um botão para liberar o uso sem restrição.</li>
          <li className="flex gap-2"><MapPin className="size-4 shrink-0 text-accent-ink" />Sem internet, os pontos ficam guardados no celular e são enviados depois.</li>
        </ul>

        <div className="text-center"><Link to="/" className="text-sm underline text-ink-2">Ir para o RASTRO</Link></div>
      </div>
    </Frame>
  );
}
