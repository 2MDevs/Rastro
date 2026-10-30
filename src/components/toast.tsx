import { createContext, useCallback, useContext, useState, ReactNode } from 'react';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';

type Toast = { id: number; tone: 'ok' | 'error' | 'info'; text: string };
const Ctx = createContext<(tone: Toast['tone'], text: string) => void>(() => {});
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], text: string) => {
    const id = Date.now() + Math.random();
    setItems((l) => [...l.slice(-3), { id, tone, text }]);
    setTimeout(() => setItems((l) => l.filter((t) => t.id !== id)), tone === 'error' ? 7000 : 4000);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="fixed z-[60] bottom-20 sm:bottom-6 left-1/2 -translate-x-1/2 flex flex-col gap-2 w-[min(92vw,420px)]" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className="flex items-start gap-3 rounded-xl border border-line bg-panel px-4 py-3 text-sm text-ink shadow-xl">
            {t.tone === 'ok' && <CheckCircle2 className="size-4 text-ok mt-0.5 shrink-0" />}
            {t.tone === 'error' && <AlertTriangle className="size-4 text-danger mt-0.5 shrink-0" />}
            {t.tone === 'info' && <Info className="size-4 text-info mt-0.5 shrink-0" />}
            <span className="flex-1">{t.text}</span>
            <button aria-label="Fechar aviso" onClick={() => setItems((l) => l.filter((x) => x.id !== t.id))} className="text-ink-3 hover:text-ink"><X className="size-4" /></button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
