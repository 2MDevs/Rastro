import { ReactNode, useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Map, Route, Megaphone, Store, Hexagon, BarChart3, Users, Smartphone, ScrollText, Server, Plug,
  ShieldCheck, LogOut, Sun, Moon, Bell, Menu, X, Navigation, Wifi, WifiOff, Download,
} from 'lucide-react';
import { nativeBridge } from '../lib/nativeApp';
import { useAuth } from '../lib/auth';
import { Logo, Symbol } from '../brand/Logo';
import { currentTheme, setTheme } from '../lib/theme';
import { get } from '../lib/api';
import { onRealtimeStatus, realtimeConnected, useRealtime } from '../lib/events';
import type { Capability } from '../lib/types';
import { IconButton, Modal, Button, cx } from './ui';

interface NavItem { to: string; label: string; icon: ReactNode; cap?: Capability; promoterOnly?: boolean; hideForPromoter?: boolean; hideInApp?: boolean }

const MAIN: NavItem[] = [
  { to: '/', label: 'Painel', icon: <LayoutDashboard className="size-[18px]" />, hideForPromoter: true },
  { to: '/mapa', label: 'Mapa', icon: <Map className="size-[18px]" />, hideForPromoter: true },
  { to: '/campo', label: 'Modo campo', icon: <Navigation className="size-[18px]" /> },
  { to: '/app', label: 'App Android', icon: <Download className="size-[18px]" />, hideInApp: true },
  { to: '/percursos', label: 'Percursos', icon: <Route className="size-[18px]" /> },
  { to: '/campanhas', label: 'Campanhas', icon: <Megaphone className="size-[18px]" />, hideForPromoter: true },
  { to: '/unidades', label: 'Unidades', icon: <Store className="size-[18px]" />, hideForPromoter: true },
  { to: '/territorios', label: 'Territórios', icon: <Hexagon className="size-[18px]" />, cap: 'territory.manage' },
  { to: '/relatorios', label: 'Relatórios', icon: <BarChart3 className="size-[18px]" />, cap: 'reports.view' },
];
const ADMIN: NavItem[] = [
  { to: '/usuarios', label: 'Usuários', icon: <Users className="size-[18px]" />, cap: 'users.manage' },
  { to: '/dispositivos', label: 'Dispositivos', icon: <Smartphone className="size-[18px]" /> },
  { to: '/auditoria', label: 'Auditoria', icon: <ScrollText className="size-[18px]" />, cap: 'audit.view' },
  { to: '/sistema', label: 'Sistema', icon: <Server className="size-[18px]" />, cap: 'system.view' },
  { to: '/integracao', label: 'Integração', icon: <Plug className="size-[18px]" />, cap: 'integration.manage' },
  { to: '/conta', label: 'Segurança da conta', icon: <ShieldCheck className="size-[18px]" /> },
];

function useNav() {
  const { user, can } = useAuth();
  const promoter = user?.role === 'PROMOTER';
  const ok = (i: NavItem) => (!i.cap || can(i.cap)) && !(promoter && i.hideForPromoter) && !(i.hideInApp && nativeBridge());
  return { main: MAIN.filter(ok), admin: ADMIN.filter(ok) };
}

function NavList({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  return (
    <ul className="space-y-0.5">
      {items.map((i) => (
        <li key={i.to}>
          <NavLink to={i.to} end={i.to === '/'} onClick={onNavigate}
            className={({ isActive }) => cx('flex items-center gap-3 rounded-xl px-3 h-10 text-sm transition-colors',
              isActive ? 'bg-amarelo text-grafite font-semibold' : 'text-ink-2 hover:text-ink hover:bg-panel-2')}>
            {i.icon}{i.label}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

function ConnectionIndicator() {
  const [api, setApi] = useState<boolean | null>(null);
  const [rt, setRt] = useState(realtimeConnected);
  useEffect(() => onRealtimeStatus(setRt), []);
  useEffect(() => {
    let alive = true;
    const check = () => fetch('/api/health', { cache: 'no-store' }).then((r) => alive && setApi(r.ok)).catch(() => alive && setApi(false));
    check();
    const t = setInterval(check, 30_000);
    const on = () => check();
    window.addEventListener('online', on); window.addEventListener('offline', on);
    return () => { alive = false; clearInterval(t); window.removeEventListener('online', on); window.removeEventListener('offline', on); };
  }, []);
  const ok = api === true;
  return (
    <span className={cx('hidden sm:inline-flex items-center gap-1.5 rounded-full border px-2.5 h-7 text-xs', ok ? 'border-ok/30 text-ok' : 'border-danger/30 text-danger')}
      title={ok ? (rt ? 'Servidor e banco no ar; atualização em tempo real ativa.' : 'Servidor e banco no ar; tempo real reconectando.') : 'Sem conexão com o servidor ou com o banco de dados.'}>
      {ok ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
      {api === null ? 'Verificando' : ok ? 'Conectado' : 'Desconectado'}
    </span>
  );
}

function UpdateBell() {
  const [notice, setNotice] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const { can } = useAuth();
  const navigate = useNavigate();
  const load = () => get('/api/system-update/notice').then(setNotice).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 10 * 60_000); return () => clearInterval(t); }, []);
  useRealtime('update', () => load(), []);
  const has = notice?.updateAvailable;
  return (
    <>
      <IconButton label={has ? 'Nova atualização disponível' : 'Avisos'} onClick={() => setOpen(true)} className="relative">
        <Bell className="size-[18px]" />
        {has && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-amarelo" />}
      </IconButton>
      <Modal open={open} onClose={() => setOpen(false)} title="Avisos"
        footer={has && can('integration.manage') ? <Button variant="primary" onClick={() => { setOpen(false); navigate('/integracao'); }}>Abrir atualização</Button> : undefined}>
        {has ? (
          <div className="text-sm text-ink-2 space-y-2">
            <p><strong className="text-ink">Nova atualização disponível</strong> (versão {notice.version}).</p>
            {notice.message && <p>{notice.message}</p>}
            <p className="text-ink-3">{can('integration.manage') ? 'Você pode aplicar pela tela Integração.' : 'A equipe de TI vai aplicar a atualização. O sistema recarrega sozinho quando ela entrar.'}</p>
          </div>
        ) : <p className="text-sm text-ink-3">Nenhum aviso no momento. O sistema está na versão mais recente.</p>}
      </Modal>
    </>
  );
}

function ThemeToggle() {
  const [t, setT] = useState(currentTheme());
  return (
    <IconButton label={t === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'} onClick={() => { const n = t === 'dark' ? 'light' : 'dark'; setTheme(n); setT(n); }}>
      {t === 'dark' ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
    </IconButton>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const { main, admin } = useNav();
  const [menu, setMenu] = useState(false);
  const loc = useLocation();
  useEffect(() => setMenu(false), [loc.pathname]);
  const scope = user?.stores === 'ALL' ? 'Painel Matriz · todas as lojas' : (user?.stores ?? []).map((s) => s.name).join(', ') || 'Nenhuma loja vinculada';
  const fullBleed = loc.pathname === '/mapa';

  const sidebar = (onNavigate?: () => void) => (
    <div className="flex flex-col h-full">
      <div className="px-5 h-16 flex items-center text-ink"><Logo height={30} tagline /></div>
      <nav className="flex-1 overflow-y-auto scroll-thin px-3 py-3 space-y-5" aria-label="Menu principal">
        <NavList items={main} onNavigate={onNavigate} />
        {admin.length > 0 && (
          <div>
            <div className="px-3 pb-1.5 text-[11px] uppercase tracking-wide text-ink-3">Administração</div>
            <NavList items={admin} onNavigate={onNavigate} />
          </div>
        )}
      </nav>
      <div className="m-3 rounded-xl border border-line bg-panel-2 p-3">
        <div className="text-sm font-medium text-ink truncate">{user?.name}</div>
        <div className="text-xs text-ink-3 truncate">{user?.roleLabel}</div>
        <div className="text-[11px] text-ink-3 mt-1 line-clamp-2" title={scope}>{scope}</div>
        <button onClick={logout} className="mt-2 inline-flex items-center gap-1.5 text-xs text-ink-2 hover:text-danger"><LogOut className="size-3.5" /> Sair</button>
      </div>
    </div>
  );

  return (
    <div className="h-full flex">
      <aside className="hidden lg:block w-64 shrink-0 bg-panel border-r border-line no-print">{sidebar()}</aside>
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-16 shrink-0 flex items-center gap-2 px-3 sm:px-5 border-b border-line bg-panel no-print">
          <IconButton label="Abrir menu" className="lg:hidden" onClick={() => setMenu(true)}><Menu className="size-5" /></IconButton>
          <div className="lg:hidden flex items-center gap-2"><Symbol size={24} /><span className="font-bold tracking-[0.18em] text-sm">RASTRO</span></div>
          <div className="hidden lg:block text-sm text-ink-3 truncate">{scope}</div>
          <div className="flex-1" />
          <ConnectionIndicator />
          <UpdateBell />
          <ThemeToggle />
        </header>
        <main className={cx('flex-1 min-h-0', fullBleed ? 'overflow-hidden' : 'overflow-y-auto scroll-thin')}>
          {fullBleed ? children : <div className="max-w-7xl mx-auto p-4 sm:p-6 pb-24">{children}</div>}
        </main>
      </div>
      {menu && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMenu(false)} />
          <aside className="absolute left-0 top-0 bottom-0 w-[82vw] max-w-72 bg-panel border-r border-line">
            <IconButton label="Fechar menu" className="absolute right-2 top-3.5" onClick={() => setMenu(false)}><X className="size-5" /></IconButton>
            {sidebar(() => setMenu(false))}
          </aside>
        </div>
      )}
    </div>
  );
}
