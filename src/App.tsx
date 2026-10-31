import { lazy, Suspense, useEffect, ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { onRealtimeStatus } from './lib/events';
import { useToast } from './components/toast';
import { AppShell } from './components/AppShell';
import { Spinner } from './components/ui';
import type { Capability } from './lib/types';
import Login from './pages/auth/Login';
import AppDownload from './pages/AppDownload';
import { ForceChangePassword, LockScreen, SetPassword } from './pages/auth/AccessScreens';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const MapPage = lazy(() => import('./pages/MapPage'));
const Sessions = lazy(() => import('./pages/Sessions'));
const SessionDetail = lazy(() => import('./pages/SessionDetail'));
const Campaigns = lazy(() => import('./pages/Campaigns'));
const CampaignDetail = lazy(() => import('./pages/CampaignDetail'));
const Stores = lazy(() => import('./pages/Stores'));
const StorePanel = lazy(() => import('./pages/StorePanel'));
const Territories = lazy(() => import('./pages/Territories'));
const Reports = lazy(() => import('./pages/Reports'));
const Users = lazy(() => import('./pages/Users'));
const Devices = lazy(() => import('./pages/Devices'));
const Audit = lazy(() => import('./pages/Audit'));
const System = lazy(() => import('./pages/System'));
const Integration = lazy(() => import('./pages/Integration'));
const Account = lazy(() => import('./pages/Account'));
const Field = lazy(() => import('./pages/Field'));

function Guard({ cap, children }: { cap?: Capability; children: ReactNode }) {
  const { can } = useAuth();
  if (cap && !can(cap)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/**
 * Versão nova aplicada no servidor: recarrega a tela sozinha.
 * Compara o arquivo principal desta tela com o que o servidor entrega agora; confere a cada 15 s,
 * quando a conexão ao vivo volta (o servidor reinicia ao atualizar) e quando a pessoa volta para a aba.
 * Durante um rastreamento pelo navegador não recarrega (para não parar o GPS): espera ele terminar.
 */
function ReloadOnDeploy() {
  const toast = useToast();
  useEffect(() => {
    try {
      if (sessionStorage.getItem('rastro-updated')) {
        sessionStorage.removeItem('rastro-updated');
        toast('ok', 'O RASTRO foi atualizado para a versão mais nova.');
      }
    } catch { /* sem armazenamento */ }
    if (!import.meta.env.PROD) return;
    const mine = (document.querySelector('script[type="module"][src*="/assets/index-"]') as HTMLScriptElement | null)?.getAttribute('src')
      ?.match(/\/assets\/index-[\w-]+\.js/)?.[0] ?? null;
    let running = false;
    const check = async () => {
      if (running || !mine) return;
      running = true;
      try {
        const html = await fetch('/', { cache: 'no-store' }).then((r) => (r.ok ? r.text() : ''));
        const sig = (html.match(/\/assets\/index-[\w-]+\.js/) || [''])[0];
        if (sig && sig !== mine && !(window as any).__rastroTrackingActive) {
          try { sessionStorage.setItem('rastro-updated', '1'); } catch { /* sem armazenamento */ }
          window.location.reload();
        }
      } catch { /* sem internet ou servidor reiniciando */ } finally { running = false; }
    };
    check();
    const t = setInterval(check, 15_000);
    const offStatus = onRealtimeStatus((up) => { if (up) setTimeout(check, 1500); });
    const vis = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); offStatus(); document.removeEventListener('visibilitychange', vis); };
  }, []);
  return null;
}

export default function App() {
  const { status, user, locked } = useAuth();
  const loc = useLocation();

  if (loc.pathname === '/definir-senha') return <SetPassword />;
  if (loc.pathname === '/app') return <AppDownload />;
  if (status === 'loading') return <div className="h-full flex items-center justify-center"><Spinner /></div>;
  if (status === 'anon' || !user) return <Login />;
  if (user.mustChangePassword) return <ForceChangePassword />;
  const promoter = user.role === 'PROMOTER';

  return (
    <AppShell>
      <ReloadOnDeploy />
      {locked && <LockScreen />}
      <Suspense fallback={<Spinner />}>
        <Routes>
          <Route path="/" element={promoter ? <Navigate to="/campo" replace /> : <Dashboard />} />
          <Route path="/mapa" element={promoter ? <Navigate to="/campo" replace /> : <MapPage />} />
          <Route path="/campo" element={<Field />} />
          <Route path="/percursos" element={<Sessions />} />
          <Route path="/percursos/:id" element={<SessionDetail />} />
          <Route path="/campanhas" element={<Campaigns />} />
          <Route path="/campanhas/:id" element={<CampaignDetail />} />
          <Route path="/unidades" element={<Stores />} />
          <Route path="/unidades/:id" element={<StorePanel />} />
          <Route path="/territorios" element={<Guard cap="territory.manage"><Territories /></Guard>} />
          <Route path="/relatorios" element={<Guard cap="reports.view"><Reports /></Guard>} />
          <Route path="/usuarios" element={<Guard cap="users.manage"><Users /></Guard>} />
          <Route path="/dispositivos" element={<Devices />} />
          <Route path="/auditoria" element={<Guard cap="audit.view"><Audit /></Guard>} />
          <Route path="/sistema" element={<Guard cap="system.view"><System /></Guard>} />
          <Route path="/integracao" element={<Guard cap="integration.manage"><Integration /></Guard>} />
          <Route path="/conta" element={<Account />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}
