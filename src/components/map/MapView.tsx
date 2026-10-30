import { useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import maplibregl, { Map as MlMap, GeoJSONSource, LngLatBoundsLike, StyleSpecification } from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { layers as pmLayers, namedFlavor } from '@protomaps/basemaps';
import { createRoot, Root } from 'react-dom/client';
import { MapPinOff } from 'lucide-react';
import { get } from '../../lib/api';
import { currentTheme, Theme } from '../../lib/theme';
import { Symbol } from '../../brand/Logo';
import type { LatLng } from '../../lib/types';

/**
 * Mapa do RASTRO. Cada camada representa uma informação real:
 *  - Unidade (loja): marcador fixo amarelo com o símbolo RASTRO
 *  - Área de cobertura: preenchimento amarelo translúcido com borda tracejada
 *  - Ruas anunciadas: linhas por situação (pendente, parcial, percorrida)
 *  - Percursos realizados: linhas azuis contínuas (trechos sem sinal não são ligados)
 *  - Pontos de interesse: círculos roxos
 *  - Posição atual de quem está em campo (ao vivo)
 */

export const MAP_COLORS = {
  area: '#F6D35C',
  streetPending: '#F6D35C',
  streetPartial: '#F2A541',
  streetDone: '#4CC38A',
  streetCandidate: '#9C9A92',
  route: '#5AA9F0',
  poi: '#B48CF2',
  live: '#5AA9F0',
  draw: '#F6D35C',
};

export type LayerKey = 'stores' | 'areas' | 'streets' | 'routes' | 'pois' | 'live';

export interface MapStore { id: string; name: string; code: string; location: LatLng | null; selected?: boolean }
export interface MapFeature { type: 'Feature'; geometry: any; properties: Record<string, any> }
export interface Selection { kind: 'store' | 'area' | 'street' | 'route' | 'poi' | 'live' | 'candidate'; props: Record<string, any>; lngLat?: [number, number] }

export interface MapViewProps {
  stores?: MapStore[];
  areas?: MapFeature[];
  streets?: MapFeature[];      // properties.status: DONE | PARTIAL | PENDING | null
  candidates?: MapFeature[];   // ruas encontradas na rede viária (planejamento); properties.planned
  routes?: MapFeature[];
  pois?: MapFeature[];
  live?: MapFeature[];
  visible?: Partial<Record<LayerKey, boolean>>;
  onSelect?: (s: Selection | null) => void;
  /** muda o valor para reenquadrar o mapa nos dados */
  fitKey?: string | number;
  focus?: { center: LatLng; zoom?: number; key: string | number } | null;
  /** desenho de perímetro */
  drawing?: boolean;
  /** mude o valor para apagar o desenho e recomeçar */
  drawKey?: number;
  onDrawChange?: (ring: [number, number][]) => void;
  /** marcar um ponto clicando */
  picking?: boolean;
  onPick?: (p: LatLng) => void;
  pickMarker?: LatLng | null;
  className?: string;
  children?: ReactNode;
}

let protocolAdded = false;
const DEFAULT_CENTER: [number, number] = [-47.9, -15.8]; // Brasil (até haver dados)

const fc = (features: MapFeature[] = []) => ({ type: 'FeatureCollection' as const, features });

function styleFor(cfg: any, theme: Theme): string | StyleSpecification {
  if (cfg?.basemap?.type === 'style') return theme === 'dark' && cfg.basemap.darkUrl ? cfg.basemap.darkUrl : cfg.basemap.url;
  return buildStyle(cfg, theme);
}

function buildStyle(cfg: any, theme: Theme): StyleSpecification {
  const bg = theme === 'dark' ? '#1A1A19' : '#ECEAE2';
  const base: StyleSpecification = {
    version: 8,
    glyphs: `${location.origin}${cfg?.glyphs ?? '/map-assets/fonts/{fontstack}/{range}.pbf'}`,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': bg } }],
  };
  if (cfg?.basemap?.type === 'pmtiles') {
    const flavor = namedFlavor(theme === 'dark' ? 'black' : 'light');
    // Fundo discreto e neutro: o destaque fica com as informações da operação
    const tuned = { ...flavor, background: bg, earth: theme === 'dark' ? '#1D1D1B' : '#F1EFE7' };
    const layers = (pmLayers('protomaps', tuned as any, { lang: 'pt' }) as any[])
      .filter((l) => !l.layout?.['icon-image']); // sem ícones de terceiros
    return {
      ...base,
      sources: { protomaps: { type: 'vector', url: `pmtiles://${location.origin}${cfg.basemap.url}`, attribution: cfg.attribution } as any },
      layers: layers as any,
    };
  }
  return base;
}

export function MapView(props: MapViewProps) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const [cfg, setCfg] = useState<any>(null);
  const [theme, setTheme] = useState<Theme>(currentTheme());
  const [ready, setReady] = useState(0);
  const markers = useRef(new Map<string, { m: maplibregl.Marker; root: Root }>());
  const pickMarker = useRef<maplibregl.Marker | null>(null);
  const drawRing = useRef<[number, number][]>([]);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    get('/api/map/config').then(setCfg).catch(() => setCfg({ basemap: null, problem: 'Não foi possível carregar a configuração do mapa.' }));
    const onTheme = (e: any) => setTheme(e.detail);
    window.addEventListener('rastro-tema', onTheme);
    return () => window.removeEventListener('rastro-tema', onTheme);
  }, []);

  // Cria o mapa
  useEffect(() => {
    if (!cfg || !el.current) return;
    if (!protocolAdded) {
      const protocol = new Protocol();
      maplibregl.addProtocol('pmtiles', protocol.tile);
      protocolAdded = true;
    }
    const style = styleFor(cfg, theme);
    const m = new maplibregl.Map({
      container: el.current, style, center: DEFAULT_CENTER, zoom: 3.6, attributionControl: { compact: true },
      dragRotate: false, pitchWithRotate: false, maxPitch: 0,
    });
    m.touchZoomRotate.disableRotation();
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    bindEvents(m);
    m.on('style.load', () => { addOverlay(m); setReady((n) => n + 1); });
    m.once('error', (ev: any) => {
      // Estilo escuro gratuito indisponível: cai para o estilo claro
      if (cfg.basemap?.darkUrl && !m.isStyleLoaded() && /style/i.test(String(ev?.error?.message ?? ''))) m.setStyle(cfg.basemap.url);
    });
    map.current = m;
    return () => {
      markers.current.forEach(({ m: mk, root }) => { mk.remove(); setTimeout(() => root.unmount()); });
      markers.current.clear();
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg]);

  // Troca de tema: refaz o estilo de fundo (as camadas de dados são recriadas no style.load)
  useEffect(() => {
    const m = map.current;
    if (!m || !cfg) return;
    if (cfg.basemap?.type === 'style' && !cfg.basemap.darkUrl) return; // estilo único do provedor
    m.setStyle(styleFor(cfg, theme), { diff: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  function addOverlay(m: MlMap) {
    const theme = currentTheme();
    const add = (id: string) => { if (!m.getSource(id)) m.addSource(id, { type: 'geojson', data: fc() }); };
    ['rs-areas', 'rs-candidates', 'rs-streets', 'rs-routes', 'rs-pois', 'rs-live', 'rs-draw'].forEach(add);
    m.addLayer({ id: 'areas-fill', type: 'fill', source: 'rs-areas', paint: { 'fill-color': MAP_COLORS.area, 'fill-opacity': 0.1 } });
    m.addLayer({ id: 'areas-line', type: 'line', source: 'rs-areas', paint: { 'line-color': MAP_COLORS.area, 'line-width': 1.6, 'line-dasharray': [3, 2], 'line-opacity': 0.9 } });
    m.addLayer({
      id: 'candidates-line', type: 'line', source: 'rs-candidates', layout: { 'line-cap': 'round' },
      paint: {
        'line-color': ['case', ['get', 'planned'], MAP_COLORS.streetPending, MAP_COLORS.streetCandidate],
        'line-width': ['case', ['get', 'planned'], 5, 3], 'line-opacity': ['case', ['get', 'planned'], 0.95, 0.55],
      },
    });
    m.addLayer({
      id: 'streets-line', type: 'line', source: 'rs-streets', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['match', ['get', 'status'], 'DONE', MAP_COLORS.streetDone, 'PARTIAL', MAP_COLORS.streetPartial, MAP_COLORS.streetPending],
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2.5, 16, 5], 'line-opacity': 0.95,
      },
    });
    m.addLayer({
      id: 'routes-line', type: 'line', source: 'rs-routes', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': MAP_COLORS.route, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 16, 3.5], 'line-opacity': 0.9 },
    });
    m.addLayer({ id: 'pois-circle', type: 'circle', source: 'rs-pois', paint: { 'circle-radius': 6, 'circle-color': MAP_COLORS.poi, 'circle-stroke-color': '#FFFFFF', 'circle-stroke-width': 1.5 } });
    m.addLayer({ id: 'pois-label', type: 'symbol', source: 'rs-pois', minzoom: 14,
      layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1.2], 'text-anchor': 'top' },
      paint: { 'text-color': theme === 'dark' ? '#E8E5DA' : '#1D1D1B', 'text-halo-color': theme === 'dark' ? '#1D1D1B' : '#FFFFFF', 'text-halo-width': 1.2 } });
    m.addLayer({ id: 'live-accuracy', type: 'circle', source: 'rs-live', paint: {
      'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 10, ['*', ['coalesce', ['get', 'accuracyM'], 0], 0.01], 20, ['*', ['coalesce', ['get', 'accuracyM'], 0], 10]],
      'circle-color': MAP_COLORS.live, 'circle-opacity': 0.12 } });
    m.addLayer({ id: 'live-dot', type: 'circle', source: 'rs-live', paint: { 'circle-radius': 7, 'circle-color': ['case', ['get', 'stale'], '#85827A', MAP_COLORS.live], 'circle-stroke-color': '#FFFFFF', 'circle-stroke-width': 2 } });
    m.addLayer({ id: 'draw-fill', type: 'fill', source: 'rs-draw', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': MAP_COLORS.draw, 'fill-opacity': 0.12 } });
    m.addLayer({ id: 'draw-line', type: 'line', source: 'rs-draw', filter: ['in', '$type', 'Polygon', 'LineString'], paint: { 'line-color': MAP_COLORS.draw, 'line-width': 2 } });
    m.addLayer({ id: 'draw-points', type: 'circle', source: 'rs-draw', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#1D1D1B', 'circle-stroke-color': MAP_COLORS.draw, 'circle-stroke-width': 2 } });

  }

  function bindEvents(m: MlMap) {
    const clickable: [string, Selection['kind']][] = [['live-dot', 'live'], ['pois-circle', 'poi'], ['routes-line', 'route'], ['streets-line', 'street'], ['candidates-line', 'candidate'], ['areas-fill', 'area']];
    for (const [id] of clickable) {
      m.on('mouseenter', id, () => { if (!propsRef.current.drawing && !propsRef.current.picking) m.getCanvas().style.cursor = 'pointer'; });
      m.on('mouseleave', id, () => { if (!propsRef.current.drawing && !propsRef.current.picking) m.getCanvas().style.cursor = ''; });
    }
    m.on('click', (e) => {
      const p = propsRef.current;
      if (p.picking) { p.onPick?.({ lat: e.lngLat.lat, lng: e.lngLat.lng }); return; }
      if (p.drawing) {
        drawRing.current = [...drawRing.current, [+e.lngLat.lng.toFixed(7), +e.lngLat.lat.toFixed(7)]];
        renderDraw();
        p.onDrawChange?.(drawRing.current);
        return;
      }
      const layers = clickable.map(([id]) => id).filter((id) => m.getLayer(id));
      const hits = m.queryRenderedFeatures(e.point, { layers });
      if (!hits.length) { p.onSelect?.(null); return; }
      const hit = hits[0];
      const kind = clickable.find(([id]) => id === hit.layer.id)![1];
      p.onSelect?.({ kind, props: hit.properties as any, lngLat: [e.lngLat.lng, e.lngLat.lat] });
    });
  }

  function renderDraw() {
    const m = map.current;
    const src = m?.getSource('rs-draw') as GeoJSONSource | undefined;
    if (!src) return;
    const ring = drawRing.current;
    const feats: any[] = ring.map((c) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: {} }));
    if (ring.length >= 3) feats.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] }, properties: {} });
    else if (ring.length === 2) feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: ring }, properties: {} });
    src.setData(fc(feats));
  }

  // Dados → fontes
  const visible = { stores: true, areas: true, streets: true, routes: true, pois: true, live: true, ...props.visible };
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const set = (id: string, feats: MapFeature[] | undefined, show: boolean) => (m.getSource(id) as GeoJSONSource | undefined)?.setData(fc(show ? feats : []));
    set('rs-areas', props.areas, visible.areas);
    set('rs-streets', props.streets, visible.streets);
    set('rs-candidates', props.candidates, true);
    set('rs-routes', props.routes, visible.routes);
    set('rs-pois', props.pois, visible.pois);
    set('rs-live', props.live, visible.live);
  }, [ready, props.areas, props.streets, props.candidates, props.routes, props.pois, props.live, visible.areas, visible.streets, visible.routes, visible.pois, visible.live]);

  // Lojas: marcadores fixos
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const wanted = new Set<string>();
    if (visible.stores) {
      for (const s of props.stores ?? []) {
        if (!s.location) continue;
        wanted.add(s.id);
        let entry = markers.current.get(s.id);
        if (!entry) {
          const node = document.createElement('button');
          node.type = 'button';
          node.setAttribute('aria-label', `Loja ${s.name}`);
          node.className = 'rs-store-marker';
          const root = createRoot(node);
          const mk = new maplibregl.Marker({ element: node, anchor: 'bottom' }).setLngLat([s.location.lng, s.location.lat]).addTo(m);
          node.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const cur = (propsRef.current.stores ?? []).find((x) => x.id === s.id);
            propsRef.current.onSelect?.({ kind: 'store', props: { id: s.id, name: cur?.name, code: cur?.code } });
          });
          entry = { m: mk, root };
          markers.current.set(s.id, entry);
        }
        entry.m.setLngLat([s.location.lng, s.location.lat]);
        entry.root.render(
          <div className="flex flex-col items-center" style={{ transform: s.selected ? 'scale(1.15)' : undefined }}>
            <div className="rounded-full bg-grafite p-1.5 border-2 border-amarelo shadow-lg"><Symbol size={22} /></div>
            <div className="mt-1 rounded-md bg-grafite/90 px-1.5 py-0.5 text-[10px] font-semibold text-white whitespace-nowrap">{s.name}</div>
          </div>
        );
      }
    }
    for (const [id, entry] of markers.current) {
      if (!wanted.has(id)) { entry.m.remove(); setTimeout(() => entry.root.unmount()); markers.current.delete(id); }
    }
  }, [ready, props.stores, visible.stores]);

  // Reenquadrar
  const fitData = useMemo(() => ({ ...props }), [props.fitKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || props.fitKey === undefined) return;
    const coords: [number, number][] = [];
    const walk = (g: any) => {
      if (!g) return;
      if (typeof g[0] === 'number') coords.push(g as [number, number]);
      else g.forEach(walk);
    };
    (fitData.stores ?? []).forEach((s) => s.location && coords.push([s.location.lng, s.location.lat]));
    for (const list of [fitData.areas, fitData.streets, fitData.routes, fitData.candidates, fitData.live]) (list ?? []).forEach((f) => walk(f.geometry?.coordinates));
    if (!coords.length) return;
    const lngs = coords.map((c) => c[0]), lats = coords.map((c) => c[1]);
    const b: LngLatBoundsLike = [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
    if (coords.length === 1) m.jumpTo({ center: coords[0], zoom: 15 });
    else m.fitBounds(b, { padding: 60, maxZoom: 16, duration: 600 });
  }, [ready, props.fitKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !props.focus) return;
    m.flyTo({ center: [props.focus.center.lng, props.focus.center.lat], zoom: props.focus.zoom ?? 15, duration: 600 });
  }, [ready, props.focus?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Desenho: reinicia ao entrar no modo
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    drawRing.current = [];
    renderDraw();
    m.getCanvas().style.cursor = props.drawing || props.picking ? 'crosshair' : '';
    if (props.drawing) m.doubleClickZoom.disable(); else m.doubleClickZoom.enable();
  }, [ready, props.drawing, props.picking, props.drawKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Marcador do ponto escolhido
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    pickMarker.current?.remove();
    pickMarker.current = null;
    if (props.pickMarker) {
      pickMarker.current = new maplibregl.Marker({ color: '#F6D35C' }).setLngLat([props.pickMarker.lng, props.pickMarker.lat]).addTo(m);
    }
  }, [ready, props.pickMarker?.lat, props.pickMarker?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`relative overflow-hidden ${props.className ?? ''}`}>
      <div ref={el} className="absolute inset-0" style={{ width: "100%", height: "100%", position: "absolute" }} />
      {cfg && (!cfg.basemap || cfg.problem) && (
        <div className="absolute left-3 bottom-8 z-10 max-w-xs flex items-start gap-2 rounded-xl border border-line bg-panel/95 px-3 py-2 text-xs text-ink-2">
          <MapPinOff className="size-4 shrink-0 text-warn mt-0.5" />
          <span>{cfg.problem}{!cfg.basemap && ' As informações da operação continuam aparecendo sobre o fundo neutro.'}</span>
        </div>
      )}
      {props.children}
    </div>
  );
}

/** Desfaz o último ponto do desenho (usado pelos botões da tela de territórios) */
export function ringToPolygon(ring: [number, number][]) {
  return ring.length >= 3 ? { type: 'Polygon' as const, coordinates: [[...ring, ring[0]]] } : null;
}
