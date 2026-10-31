import { ReactNode, useEffect, useLayoutEffect, useRef, useState, ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes, forwardRef } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, X, AlertTriangle, Inbox } from 'lucide-react';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export { cx };

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
export function Button({ variant = 'secondary', loading, className, children, icon, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-xl px-4 h-10 text-sm font-medium transition-colors whitespace-nowrap',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        variant === 'primary' && 'bg-amarelo text-grafite hover:bg-amarelo-forte',
        variant === 'secondary' && 'bg-panel-2 text-ink border border-line hover:border-ink-3',
        variant === 'ghost' && 'text-ink-2 hover:text-ink hover:bg-panel-2',
        variant === 'danger' && 'bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25',
        className
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button {...rest} aria-label={label} title={label}
      className={cx('inline-flex items-center justify-center size-9 rounded-lg text-ink-2 hover:text-ink hover:bg-panel-2 transition-colors disabled:opacity-40', className)}>
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children, className }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="block text-xs font-medium text-ink-2 mb-1.5">{label}</span>
      {children}
      {hint && !error && <span className="block text-xs text-ink-3 mt-1">{hint}</span>}
      {error && <span className="block text-xs text-danger mt-1">{error}</span>}
    </label>
  );
}

const inputCls = 'w-full h-10 rounded-xl bg-panel-2 border border-line px-3 text-sm text-ink placeholder:text-ink-3 focus:border-amarelo focus:outline-none transition-colors disabled:opacity-60';
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...rest }, ref) => (
  <input ref={ref} {...rest} className={cx(inputCls, className)} />
));
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...rest} className={cx(inputCls, 'pr-8', className)}>{children}</select>;
}
export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cx(inputCls, 'h-auto min-h-20 py-2', className)} />;
}

export function Checkbox({ checked, onChange, label, description }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; description?: ReactNode }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer select-none">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 accent-[#F6D35C]" />
      <span className="text-sm">
        <span className="text-ink">{label}</span>
        {description && <span className="block text-xs text-ink-3 mt-0.5">{description}</span>}
      </span>
    </label>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={cx('relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40', checked ? 'bg-amarelo' : 'bg-line')}>
      <span className={cx('absolute top-0.5 size-5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-5.5' : 'translate-x-0.5')} />
    </button>
  );
}

export function Card({ title, actions, children, className, padded = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cx('rounded-2xl bg-panel border border-line', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 sm:px-5 pt-4 pb-3">
          {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx(padded && 'px-4 sm:px-5 pb-4 sm:pb-5', !title && !actions && padded && 'pt-4 sm:pt-5')}>{children}</div>
    </section>
  );
}

const TONES = {
  neutral: 'bg-panel-2 text-ink-2 border-line',
  yellow: 'bg-amarelo/15 text-accent-ink border-amarelo/30',
  ok: 'bg-ok/12 text-ok border-ok/30',
  warn: 'bg-warn/12 text-warn border-warn/30',
  danger: 'bg-danger/12 text-danger border-danger/30',
  info: 'bg-info/12 text-info border-info/30',
};
export type Tone = keyof typeof TONES;
export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap', TONES[tone], className)}>{children}</span>;
}

export function Spinner({ label = 'Carregando...' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-ink-3" role="status">
      <Loader2 className="size-4 animate-spin" /> {label}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center px-6 py-12">
      <div className="size-12 rounded-2xl bg-panel-2 border border-line flex items-center justify-center text-ink-3 mb-4">{icon ?? <Inbox className="size-5" />}</div>
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {children && <div className="text-sm text-ink-3 mt-1.5 max-w-md">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorBox({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger" role="alert">
      <AlertTriangle className="size-4 mt-0.5 shrink-0" />
      <div className="flex-1">{children}</div>
      {onRetry && <button className="underline shrink-0" onClick={onRetry}>Tentar de novo</button>}
    </div>
  );
}

export function Notice({ tone = 'info', children, icon }: { tone?: 'info' | 'warn' | 'ok'; children: ReactNode; icon?: ReactNode }) {
  return (
    <div className={cx('flex items-start gap-3 rounded-xl border px-4 py-3 text-sm',
      tone === 'info' && 'border-info/30 bg-info/8 text-ink-2', tone === 'warn' && 'border-warn/30 bg-warn/10 text-ink-2', tone === 'ok' && 'border-ok/30 bg-ok/10 text-ink-2')}>
      {icon && <span className={cx('mt-0.5 shrink-0', tone === 'info' && 'text-info', tone === 'warn' && 'text-warn', tone === 'ok' && 'text-ok')}>{icon}</span>}
      <div className="flex-1">{children}</div>
    </div>
  );
}

/** Janela lateral (no celular, ocupa a tela) */
export function Drawer({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <aside role="dialog" aria-modal="true" className={cx('relative h-full w-full bg-panel border-l border-line flex flex-col', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}>
        <header className="flex items-center justify-between gap-3 px-5 h-16 border-b border-line shrink-0">
          <h2 className="font-semibold text-ink truncate">{title}</h2>
          <IconButton label="Fechar" onClick={onClose}><X className="size-5" /></IconButton>
        </header>
        <div className="flex-1 overflow-y-auto scroll-thin p-5">{children}</div>
        {footer && <footer className="flex flex-wrap items-center justify-end gap-2 px-5 py-4 border-t border-line shrink-0 pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</footer>}
      </aside>
    </div>,
    document.body
  );
}

export function Modal({ open, onClose, title, children, footer }: { open: boolean; onClose?: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    if (!open || !onClose) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/55" onClick={onClose} />
      <div role="dialog" aria-modal="true" className="relative w-full sm:max-w-md max-h-[92dvh] overflow-y-auto scroll-thin bg-panel border border-line rounded-t-2xl sm:rounded-2xl shadow-2xl pb-safe">
        <header className="flex items-center justify-between gap-3 px-5 pt-5">
          <h2 className="font-semibold text-ink">{title}</h2>
          {onClose && <IconButton label="Fechar" onClick={onClose}><X className="size-5" /></IconButton>}
        </header>
        <div className="px-5 py-4">{children}</div>
        {footer && <footer className="flex flex-wrap items-center justify-end gap-2 px-5 pb-5 [&>*]:flex-1 sm:[&>*]:flex-none">{footer}</footer>}
      </div>
    </div>,
    document.body
  );
}

/** Confirmação antes de ações importantes */
export function useConfirm() {
  const [state, setState] = useState<null | { title: string; body: ReactNode; confirm: string; danger?: boolean; resolve: (v: boolean) => void }>(null);
  const ask = (title: string, body: ReactNode, confirm = 'Confirmar', danger = false) =>
    new Promise<boolean>((resolve) => setState({ title, body, confirm, danger, resolve }));
  const close = (v: boolean) => { state?.resolve(v); setState(null); };
  const element = (
    <Modal open={Boolean(state)} onClose={() => close(false)} title={state?.title}
      footer={<>
        <Button variant="ghost" onClick={() => close(false)}>Cancelar</Button>
        <Button variant={state?.danger ? 'danger' : 'primary'} onClick={() => close(true)}>{state?.confirm}</Button>
      </>}>
      <div className="text-sm text-ink-2">{state?.body}</div>
    </Modal>
  );
  return { ask, element };
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode }[] }) {
  return (
    <div className="flex gap-1 overflow-x-auto scroll-thin border-b border-line" role="tablist">
      {items.map((it) => (
        <button key={it.value} role="tab" aria-selected={value === it.value} onClick={() => onChange(it.value)}
          className={cx('px-3.5 h-10 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors',
            value === it.value ? 'border-amarelo text-ink font-medium' : 'border-transparent text-ink-3 hover:text-ink')}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-4 sm:mb-5">
      <div className="min-w-0">
        <h1 className="text-lg sm:text-xl font-semibold text-ink">{title}</h1>
        {subtitle && <p className="text-xs sm:text-sm text-ink-3 mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto [&>*]:flex-1 sm:[&>*]:flex-none [&_button]:w-full sm:[&_button]:w-auto">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, icon }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex items-start gap-3 min-w-0">
      {icon && <div className="size-8 sm:size-9 shrink-0 rounded-xl bg-panel-2 border border-line flex items-center justify-center text-accent-ink">{icon}</div>}
      <div className="min-w-0">
        <div className="text-[10.5px] sm:text-[11px] uppercase tracking-wide text-ink-3 leading-tight">{label}</div>
        <div className="text-base sm:text-lg font-semibold text-ink tabular leading-snug break-words sm:truncate">{value}</div>
        {hint && <div className="text-[11px] sm:text-xs text-ink-3 line-clamp-2 sm:truncate">{hint}</div>}
      </div>
    </div>
  );
}

/** Tabela simples e responsiva */
export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: ReactNode }) {
  // No celular a tabela vira cartões: cada célula recebe o nome da coluna (data-label) para aparecer ao lado do valor
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const label = () => {
      const names = [...el.querySelectorAll('thead th')].map((th) => (th.textContent || '').trim());
      el.querySelectorAll('tbody > tr').forEach((tr) => {
        [...tr.children].forEach((td, i) => { if (td.getAttribute('data-label') !== (names[i] ?? '')) td.setAttribute('data-label', names[i] ?? ''); });
      });
    };
    label();
    const mo = new MutationObserver(label);
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);
  return (
    <div ref={ref} className="rt overflow-x-auto scroll-thin">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-ink-3 border-b border-line">
            {head.map((h, i) => <th key={i} className="font-medium px-3 py-2.5 whitespace-nowrap first:pl-5 last:pr-5">{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
      {empty}
    </div>
  );
}
export const Td = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <td className={cx('px-3 py-3 align-middle first:pl-5 last:pr-5', className)}>{children}</td>
);
