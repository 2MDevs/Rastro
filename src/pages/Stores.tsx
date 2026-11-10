import { FormEvent, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Plus, Store as StoreIcon, MapPin, Pencil, Crosshair, LayoutDashboard, LocateFixed, Loader2 } from 'lucide-react';
import { ApiError, post, put } from '../lib/api';
import { parseCoords } from '../lib/coords';
import { useAuth } from '../lib/auth';
import { relative } from '../lib/format';
import type { LatLng, Store } from '../lib/types';
import { useStores, invalidateStores } from '../components/filters';
import { MapView } from '../components/map/MapView';
import { useToast } from '../components/toast';
import { Badge, Button, Card, Drawer, EmptyState, ErrorBox, Field, Input, PageHeader, Select, Spinner, Table, Td, Notice } from '../components/ui';

export default function Stores() {
  const { can, user } = useAuth();
  const navigate = useNavigate();
  const { stores, loading, reload } = useStores();
  const [editing, setEditing] = useState<Store | 'new' | null>(null);
  const manage = can('stores.manage');
  // Quem tem uma loja só vai direto para o painel dela
  if (user?.stores !== 'ALL' && stores.length === 1 && !loading) return <Navigate to={`/unidades/${stores[0].id}`} replace />;

  return (
    <div>
      <PageHeader title="Unidades" subtitle="Lojas da rede e a localização usada no mapa"
        actions={manage && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Nova loja</Button>} />
      <Card padded={false}>
        {loading && !stores.length ? <Spinner /> : stores.length ? (
          <Table head={['Loja', 'Situação', 'Operação', 'Última atividade', '']}>
            {stores.map((s) => (
              <tr key={s.id} className="hover:bg-panel-2 cursor-pointer" onClick={() => navigate(`/unidades/${s.id}`)}>
                <Td className="min-w-0">
                  <Link to={`/unidades/${s.id}`} className="font-medium text-ink hover:underline" onClick={(e) => e.stopPropagation()}>{s.name}</Link>
                  <div className="text-xs text-ink-3 truncate max-w-[22rem]" title={s.address || undefined}>{s.code}{s.address ? ` · ${s.address}` : ' · endereço a definir'}</div>
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1 justify-end md:justify-start">
                    {s.status === 'INACTIVE' ? <Badge>Inativa</Badge> : s.operating ? <Badge tone="ok">Em operação</Badge> : <Badge tone="neutral">Cadastrada</Badge>}
                    {s.location ? (s.locationInfo?.source === 'GPS' ? <Badge tone="ok"><MapPin className="size-3" /> GPS</Badge> : <Badge tone="yellow"><MapPin className="size-3" /> Mapa</Badge>) : <Badge tone="warn"><MapPin className="size-3" /> Sem local</Badge>}
                  </div>
                </Td>
                <Td className="text-xs text-ink-2 whitespace-nowrap">{s.activeCampaigns} campanha(s) ativa(s)<div className="text-ink-3">{s.areas} território(s)</div></Td>
                <Td className="text-xs text-ink-3 whitespace-nowrap">{s.lastActivityAt ? relative(s.lastActivityAt) : '—'}</Td>
                <Td className="text-right whitespace-nowrap w-px">
                  <span className="inline-flex gap-1" onClick={(e) => e.stopPropagation()}>
                    <Link to={`/unidades/${s.id}`}><Button variant="ghost" icon={<LayoutDashboard className="size-4" />}>Abrir</Button></Link>
                    {manage && <Button variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEditing(s)} aria-label={`Editar ${s.name}`} title="Editar loja" />}
                  </span>
                </Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState icon={<StoreIcon className="size-5" />} title="Nenhuma loja cadastrada" action={manage && <Button variant="primary" onClick={() => setEditing('new')}>Cadastrar a primeira loja</Button>}>
            {manage ? 'Cadastre as lojas com o endereço para vê-las no mapa e planejar os territórios.' : 'Nenhuma loja está vinculada ao seu acesso. Fale com a administração.'}
          </EmptyState>
        )}
      </Card>
      <p className="text-xs text-ink-3 mt-3">"Cadastrada" significa só que a loja existe no sistema. "Em operação" aparece quando ela tem pelo menos uma campanha ativa. A localização mais precisa é a registrada pelo GPS do celular dentro da loja (no Painel da loja).</p>
      {editing && <StoreForm store={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(created) => { invalidateStores(); reload(); setEditing(null); if (created) navigate(`/unidades/${created.id}`); }} />}
    </div>
  );
}

function StoreForm({ store, onClose, onSaved }: { store: Store | null; onClose: () => void; onSaved: (created?: Store) => void }) {
  const toast = useToast();
  const [code, setCode] = useState(store?.code ?? '');
  const [name, setName] = useState(store?.name ?? '');
  const [address, setAddress] = useState(store?.address ?? '');
  const [status, setStatus] = useState(store?.status ?? 'ACTIVE');
  const [location, setLocation] = useState<LatLng | null>(store?.location ?? null);
  const [picking, setPicking] = useState(false);
  // Coordenadas coladas do Google Maps (ex.: -22.8436, -43.6078)
  const [coordText, setCoordText] = useState('');
  const coordParsed = parseCoords(coordText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState(0);
  // Localização atual pelo GPS do aparelho (a pessoa está dentro da loja)
  const [gps, setGps] = useState<{ accuracy: number; at: number } | null>(null);
  const [locating, setLocating] = useState<number | null>(null);

  function captureCurrentLocation() {
    setError(null);
    if (!window.isSecureContext || !('geolocation' in navigator)) { setError('Este navegador não oferece localização. Use o celular.'); return; }
    setPicking(false);
    setLocating(0);
    let best: GeolocationPosition | null = null;
    const started = Date.now();
    const done = () => {
      navigator.geolocation.clearWatch(id);
      window.clearInterval(tick);
      setLocating(null);
      if (!best) { setError('Não foi possível obter a localização. Ligue o GPS (localização precisa) e tente de novo.'); return; }
      setLocation({ lat: best.coords.latitude, lng: best.coords.longitude });
      setGps({ accuracy: best.coords.accuracy, at: best.timestamp });
      setFocusKey((k) => k + 1);
    };
    const tick = window.setInterval(() => {
      const sec = Math.round((Date.now() - started) / 1000);
      setLocating(best ? Math.round(best.coords.accuracy) : 0);
      if (sec >= 15) done();
    }, 500);
    const id = navigator.geolocation.watchPosition((pos) => {
      if (!best || pos.coords.accuracy < best.coords.accuracy) best = pos;
      setLocating(Math.round(best.coords.accuracy));
      if (best.coords.accuracy <= 20 && Date.now() - started > 3000) done();
    }, (err) => {
      navigator.geolocation.clearWatch(id);
      window.clearInterval(tick);
      setLocating(null);
      setError(err.code === err.PERMISSION_DENIED
        ? 'O acesso à localização foi negado. Libere a localização para este site nas configurações do navegador.'
        : 'Não foi possível obter a localização. Ligue o GPS (localização precisa) e tente de novo.');
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 });
  }

  function applyCoords(text = coordText) {
    const c = parseCoords(text);
    if (!c) { setError('Não entendi as coordenadas. Cole no formato -22.843600, -43.607825 (copiado do Google Maps).'); return; }
    setError(null); setLocation(c); setGps(null); setPicking(false); setFocusKey((k) => k + 1);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    // Mensagem no topo do formulário e também no aviso flutuante (no celular o topo pode estar fora da tela)
    const fail = (m: string) => { setError(m); toast('error', m); };
    if (!name.trim()) { fail('Informe o nome da loja.'); return; }
    if (locating !== null) { fail('Aguarde terminar a leitura do GPS.'); return; }
    setBusy(true); setError(null);
    // Com GPS aceitável, a localização é gravada como "GPS dentro da loja" (com a precisão); senão, como marcada no mapa
    const gpsOk = gps && location && gps.accuracy <= 100;
    const body: any = { code: code.trim() || null, name, address: address || null, status };
    const changed = (location?.lat ?? null) !== (store?.location?.lat ?? null) || (location?.lng ?? null) !== (store?.location?.lng ?? null);
    if (!gpsOk && (!store || changed)) body.location = location;
    try {
      let saved: Store;
      if (store) saved = await patch<Store>(`/api/stores/${store.id}`, body);
      else saved = await post<Store>('/api/stores', body);
      if (gpsOk) {
        await put(`/api/stores/${saved.id}/location`, {
          lat: location!.lat, lng: location!.lng, accuracyM: gps!.accuracy, capturedAt: new Date(gps!.at).toISOString(), insideStore: true,
        });
      }
      toast('ok', store ? 'Loja atualizada.' : location ? 'Loja cadastrada com a localização.' : 'Loja cadastrada. Registre a localização e vincule as pessoas da loja.');
      onSaved(store ? undefined : saved);
    } catch (err) { fail(err instanceof ApiError ? err.message : 'Não foi possível salvar.'); } finally { setBusy(false); }
  }

  return (
    <Drawer open onClose={onClose} title={store ? `Editar ${store.name}` : 'Nova loja'} wide
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={submit as any}>Salvar</Button></>}>
      <form onSubmit={submit} className="space-y-4">
        {error && <ErrorBox>{error}</ErrorBox>}
        <div className="grid sm:grid-cols-[140px_1fr] gap-3">
          <Field label="Código (opcional)" hint={store ? undefined : 'Vazio = o sistema gera'}><Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Ex.: 012" maxLength={30} /></Field>
          <Field label="Nome da loja *"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Ex.: Hummm! Centro" /></Field>
        </div>
        <Field label="Endereço" hint="Como aparece para as pessoas. A posição no mapa é definida abaixo."><Input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} /></Field>
        {store && (
          <Field label="Situação">
            <Select value={status} onChange={(e) => setStatus(e.target.value as any)}><option value="ACTIVE">Ativa</option><option value="INACTIVE">Inativa</option></Select>
          </Field>
        )}
        <div>
          <span className="block text-xs font-medium text-ink-2 mb-1.5">Localização no mapa</span>
          <Button type="button" variant="primary" className="w-full h-12 mb-2" icon={locating !== null ? <Loader2 className="size-5 animate-spin" /> : <LocateFixed className="size-5" />}
            onClick={captureCurrentLocation} disabled={locating !== null}>
            {locating !== null ? `Lendo o GPS...${locating ? ` precisão ± ${locating} m` : ''}` : 'Usar minha localização atual (estou na loja)'}
          </Button>
          {gps && location && (
            <div className="mb-2"><Notice tone={gps.accuracy <= 50 ? 'ok' : 'warn'}>
              Localização atual capturada com precisão de <strong>± {Math.round(gps.accuracy)} m</strong>. Confira se o marcador está em cima da loja.
              {gps.accuracy > 100 && ' A precisão está baixa: vai ser salva como "marcada no mapa". Para melhorar, vá perto da porta e tente de novo.'}
            </Notice></div>
          )}
          <p className="text-xs text-ink-3 mb-2">Ou cole as coordenadas do Google Maps:</p>
          <div className="flex gap-2">
            <Input value={coordText} inputMode="text" autoComplete="off" spellCheck={false}
              onChange={(e) => setCoordText(e.target.value)}
              onPaste={(e) => { const t = e.clipboardData.getData('text'); if (parseCoords(t)) { e.preventDefault(); setCoordText(t.trim()); applyCoords(t); } }}
              placeholder="Ex.: -22.843600, -43.607825" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyCoords(); } }}
              aria-label="Coordenadas da loja (latitude, longitude)" />
            <Button type="button" icon={<MapPin className="size-4" />} onClick={() => applyCoords()} disabled={!coordParsed}>Usar</Button>
          </div>
          <p className="text-[11px] text-ink-3 mt-1">
            No Google Maps, clique com o botão direito em cima da loja (no celular, toque e segure) e copie os números que aparecem. Também aceita o link do Google Maps.
            {coordText && !coordParsed && <span className="text-warn"> Formato não reconhecido.</span>}
          </p>
          <div className="mt-3 rounded-xl overflow-hidden border border-line">
            <MapView className="h-80" picking={picking} onPick={(p) => { setLocation(p); setGps(null); setPicking(false); }} pickMarker={location}
              focus={location ? { center: location, zoom: 16, key: focusKey } : null} visible={{ stores: false }} />
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <Button type="button" variant={picking ? 'primary' : 'secondary'} icon={<Crosshair className="size-4" />} onClick={() => setPicking((p) => !p)}>
              {picking ? 'Clique no mapa para marcar' : 'Marcar no mapa'}
            </Button>
            {location && <span className="text-xs text-ink-3 tabular">{location.lat.toFixed(6)}, {location.lng.toFixed(6)}</span>}
            {location && <Button type="button" variant="ghost" onClick={() => { setLocation(null); setGps(null); }}>Remover localização</Button>}
          </div>
          {!location && <Notice tone="warn">Sem localização, a loja não aparece no mapa e não é possível criar um território por raio a partir dela.</Notice>}
        </div>
        {store && <p className="text-xs text-ink-3">As pessoas vinculadas a esta loja são definidas em <Link to="/usuarios" className="underline">Usuários</Link>.</p>}
      </form>
    </Drawer>
  );
}
