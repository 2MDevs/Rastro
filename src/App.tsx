import { lazy, Suspense, useEffect, ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { AppShell } from './components/AppShell';
import { Spinner } from './components/ui';
import type { Capability } from './lib/types';
import Login from './pages/auth/Login';
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

/** Versão nova aplicada no servidor: recarrega a tela (o service worker busca os arquivos novos) */
function ReloadOnDeploy() {
  useEffect(() => {
    let current: string | null = null;
    const check = async () => {
      try {
        const html = await fetch('/', { cache: 'no-store' }).then((r) => r.text());
        const sig = (html.match(/\/assets\/index-[\w-]+\.js/) || [''])[0];
        if (current === null) current = sig;
        else if (sig && sig !== current && !(window as any).__rastroTrackingActive) window.location.reload();
      } catch { /* sem internet */ }
    };
    if (import.meta.env.PROD) { check(); const t = setInterval(check, 2 * 60_000); return () => clearInterval(t); }
  }, []);
  return null;
}

export default function App() {
  const { status, user, locked } = useAuth();
  const loc = useLocation();

  if (loc.pathname === '/definir-senha') return <SetPassword />;
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
