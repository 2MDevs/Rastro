import { FormEvent, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Plus, Search, Store as StoreIcon, MapPin, Pencil, Crosshair, LayoutDashboard } from 'lucide-react';
import { ApiError, get, patch, post, qs } from '../lib/api';
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
          <Table head={['Loja', 'Endereço', 'Localização', 'Situação', 'Campanhas ativas', 'Territórios', 'Última atividade', '']}>
            {stores.map((s) => (
              <tr key={s.id} className="hover:bg-panel-2 cursor-pointer" onClick={() => navigate(`/unidades/${s.id}`)}>
                <Td><Link to={`/unidades/${s.id}`} className="font-medium text-ink hover:underline" onClick={(e) => e.stopPropagation()}>{s.name}</Link><div className="text-xs text-ink-3">{s.code}</div></Td>
                <Td className="text-ink-2 max-w-64 truncate">{s.address || <span className="text-ink-3">A definir</span>}</Td>
                <Td>{s.location ? (s.locationInfo?.source === 'GPS' ? <Badge tone="ok"><MapPin className="size-3" /> GPS na loja</Badge> : <Badge tone="yellow"><MapPin className="size-3" /> Marcada no mapa</Badge>) : <Badge tone="warn">A definir</Badge>}</Td>
                <Td>{s.status === 'INACTIVE' ? <Badge>Inativa</Badge> : s.operating ? <Badge tone="ok">Em operação</Badge> : <Badge tone="neutral">Cadastrada</Badge>}</Td>
                <Td className="tabular">{s.activeCampaigns}</Td>
                <Td className="tabular">{s.areas}</Td>
                <Td className="text-xs text-ink-3">{s.lastActivityAt ? relative(s.lastActivityAt) : '—'}</Td>
                <Td className="text-right whitespace-nowrap" >
                  <span onClick={(e) => e.stopPropagation()}>
                    <Link to={`/unidades/${s.id}`}><Button variant="ghost" icon={<LayoutDashboard className="size-4" />}>Painel da loja</Button></Link>
                    {manage && <Button variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEditing(s)}>Editar</Button>}
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
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState(0);

  useEffect(() => { if (!search && address) setSearch(address); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function doSearch() {
    setSearching(true); setError(null);
    try { setResults(await get(`/api/map/geocode${qs({ q: search })}`)); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Busca indisponível.'); }
    finally { setSearching(false); }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const body = { code, name, address: address || null, location, status };
    try {
      if (store) { await patch(`/api/stores/${store.id}`, body); toast('ok', 'Loja atualizada.'); onSaved(); }
      else { const created = await post<Store>('/api/stores', body); toast('ok', 'Loja cadastrada. Agora registre a localização e vincule as pessoas da loja.'); onSaved(created); }
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.'); } finally { setBusy(false); }
  }

  return (
    <Drawer open onClose={onClose} title={store ? `Editar ${store.name}` : 'Nova loja'} wide
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={submit as any} disabled={!code || !name}>Salvar</Button></>}>
      <form onSubmit={submit} className="space-y-4">
        {error && <ErrorBox>{error}</ErrorBox>}
        <div className="grid sm:grid-cols-[140px_1fr] gap-3">
          <Field label="Código"><Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Ex.: 012" maxLength={30} /></Field>
          <Field label="Nome da loja"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
        </div>
        <Field label="Endereço" hint="Como aparece para as pessoas. A posição no mapa é definida abaixo."><Input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} /></Field>
        {store && (
          <Field label="Situação">
            <Select value={status} onChange={(e) => setStatus(e.target.value as any)}><option value="ACTIVE">Ativa</option><option value="INACTIVE">Inativa</option></Select>
          </Field>
        )}
        <div>
          <span className="block text-xs font-medium text-ink-2 mb-1.5">Localização no mapa</span>
          <div className="flex gap-2">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar endereço" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } }} />
            <Button type="button" icon={<Search className="size-4" />} loading={searching} onClick={doSearch} disabled={search.trim().length < 4}>Buscar</Button>
          </div>
          {results.length > 0 && (
            <ul className="mt-2 rounded-xl border border-line divide-y divide-line max-h-48 overflow-y-auto scroll-thin">
              {results.map((r, i) => (
                <li key={i}><button type="button" className="w-full text-left px-3 py-2 text-sm hover:bg-panel-2" onClick={() => { setLocation({ lat: r.lat, lng: r.lng }); setResults([]); setFocusKey((k) => k + 1); }}>{r.label}</button></li>
              ))}
            </ul>
          )}
          <div className="mt-3 rounded-xl overflow-hidden border border-line">
            <MapView className="h-80" picking={picking} onPick={(p) => { setLocation(p); setPicking(false); }} pickMarker={location}
              focus={location ? { center: location, zoom: 16, key: focusKey } : null} visible={{ stores: false }} />
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <Button type="button" variant={picking ? 'primary' : 'secondary'} icon={<Crosshair className="size-4" />} onClick={() => setPicking((p) => !p)}>
              {picking ? 'Clique no mapa para marcar' : 'Marcar no mapa'}
            </Button>
            {location && <span className="text-xs text-ink-3 tabular">{location.lat.toFixed(6)}, {location.lng.toFixed(6)}</span>}
            {location && <Button type="button" variant="ghost" onClick={() => setLocation(null)}>Remover localização</Button>}
          </div>
          {!location && <Notice tone="warn">Sem localização, a loja não aparece no mapa e não é possível criar um território por raio a partir dela.</Notice>}
        </div>
        {store && <p className="text-xs text-ink-3">As pessoas vinculadas a esta loja são definidas em <Link to="/usuarios" className="underline">Usuários</Link>.</p>}
      </form>
    </Drawer>
  );
}
