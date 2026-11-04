import { pool } from '../db';
import { getValue } from '../settings';
import { haversine, LngLat, TrackBridge } from './geo';

/**
 * Trechos sem sinal de GPS (túnel, viaduto, prédios altos, celular guardado no fundo da bolsa).
 *
 * O caminho real nesses intervalos NÃO foi medido. Para o mapa não ficar "cortado", o RASTRO liga o último
 * ponto antes da falha ao primeiro ponto depois dela pelo caminho mais curto nas ruas do OpenStreetMap
 * (consulta ao Overpass), e desenha esse trecho tracejado, como estimado. Se não houver um caminho pelas
 * ruas que faça sentido, liga em linha reta tracejada.
 *
 * - O cálculo é feito em segundo plano e guardado (tabela track_bridges): o mapa nunca espera por ele.
 *   Enquanto não fica pronto, o trecho aparece em linha reta tracejada.
 * - Trechos estimados não entram na distância medida nem na cobertura das ruas.
 */

export interface BridgeGeometry { coordinates: LngLat[]; method: 'STREETS' | 'STRAIGHT' }

const keyOf = (b: TrackBridge) => `${b.from[0].toFixed(5)},${b.from[1].toFixed(5)}>${b.to[0].toFixed(5)},${b.to[1].toFixed(5)}`;

/** Geometria de cada trecho sem sinal: a calculada pelas ruas, se pronta; senão linha reta (e pede o cálculo) */
export async function bridgeGeometries(bridges: TrackBridge[]): Promise<BridgeGeometry[]> {
  if (!bridges.length) return [];
  const keys = bridges.map(keyOf);
  let known = new Map<string, BridgeGeometry>();
  try {
    const { rows } = await pool.query('SELECT key, geometry, method FROM track_bridges WHERE key = ANY($1::text[])', [keys]);
    known = new Map(rows.map((r) => [r.key, { coordinates: r.geometry, method: r.method }]));
  } catch { /* tabela ainda não criada: tudo em linha reta */ }
  return bridges.map((b, i) => {
    const hit = known.get(keys[i]);
    if (hit) return hit;
    enqueue(keys[i], b);
    return { coordinates: [b.from, b.to], method: 'STRAIGHT' };
  });
}

// ------------------------------------------------------------------ fila de cálculo (um por vez)
const pending = new Map<string, TrackBridge>();
const failedAt = new Map<string, number>();
let running = false;

function enqueue(key: string, b: TrackBridge) {
  if (pending.has(key) || pending.size > 500) return;
  if (Date.now() - (failedAt.get(key) ?? 0) < 10 * 60_000) return; // falhou há pouco (serviço ocupado): espera
  pending.set(key, b);
  if (!running) void drain();
}

async function drain() {
  running = true;
  try {
    while (pending.size) {
      const [key, b] = pending.entries().next().value as [string, TrackBridge];
      pending.delete(key);
      try {
        const geom = await routeOnStreets(b);
        await pool.query(
          `INSERT INTO track_bridges (key, geometry, method, length_m) VALUES ($1, $2, $3, $4)
           ON CONFLICT (key) DO NOTHING`,
          [key, JSON.stringify(geom.coordinates), geom.method, lengthOf(geom.coordinates)]
        );
      } catch (err) {
        failedAt.set(key, Date.now());
        console.warn('[trechos sem sinal] cálculo adiado:', (err as Error).message);
      }
      await new Promise((r) => setTimeout(r, 1500)); // respeita o serviço público do Overpass
    }
  } finally {
    running = false;
  }
}

const lengthOf = (c: LngLat[]) => c.slice(1).reduce((s, p, i) => s + haversine(c[i], p), 0);

// ------------------------------------------------------------------ caminho mais curto pelas ruas
async function routeOnStreets(b: TrackBridge): Promise<BridgeGeometry> {
  const url = await getValue('OVERPASS_URL');
  const straight: BridgeGeometry = { coordinates: [b.from, b.to], method: 'STRAIGHT' };
  if (!url || b.meters < 40) return straight;

  // Caixa em volta dos dois pontos, com folga para o caminho fazer curvas
  const padDeg = Math.min(0.012, Math.max(0.003, (b.meters * 0.35) / 111_000));
  const s = Math.min(b.from[1], b.to[1]) - padDeg, n = Math.max(b.from[1], b.to[1]) + padDeg;
  const w = Math.min(b.from[0], b.to[0]) - padDeg, e = Math.max(b.from[0], b.to[0]) + padDeg;
  const query = `[out:json][timeout:25];way["highway"]["highway"!~"^(construction|proposed|abandoned|platform|raceway|bus_stop|elevator)$"]["area"!="yes"](${s.toFixed(6)},${w.toFixed(6)},${n.toFixed(6)},${e.toFixed(6)});out geom;`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 35_000);
  let data: any;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'RASTRO/1.0 (Hummm! Pizzas - TI; plataforma interna)' },
      body: new URLSearchParams({ data: query }).toString(),
    });
    if (!resp.ok) throw new Error(`Overpass respondeu ${resp.status}`);
    data = await resp.json();
  } finally {
    clearTimeout(timer);
  }

  // Grafo: cada vértice das ruas vira um nó (vértices iguais entre ruas = cruzamento)
  const id = new Map<string, number>();
  const coords: LngLat[] = [];
  const adj: Array<Array<[number, number]>> = [];
  const edges: Array<[number, number]> = [];
  const node = (c: LngLat) => {
    const k = `${c[0].toFixed(7)},${c[1].toFixed(7)}`;
    let i = id.get(k);
    if (i === undefined) { i = coords.length; id.set(k, i); coords.push(c); adj.push([]); }
    return i;
  };
  const link = (a: number, z: number) => {
    const d = haversine(coords[a], coords[z]);
    adj[a].push([z, d]); adj[z].push([a, d]); // a pé não há mão única
  };
  for (const el of data?.elements ?? []) {
    if (el.type !== 'way' || !Array.isArray(el.geometry)) continue;
    let prev = -1;
    for (const g of el.geometry) {
      if (!Number.isFinite(g?.lat) || !Number.isFinite(g?.lon)) { prev = -1; continue; }
      const cur = node([g.lon, g.lat]);
      if (prev >= 0 && prev !== cur) { link(prev, cur); edges.push([prev, cur]); }
      prev = cur;
    }
  }
  if (edges.length < 2) return straight;

  const snapA = snap(b.from, coords, edges);
  const snapB = snap(b.to, coords, edges);
  const SNAP_MAX = 80;
  if (!snapA || !snapB || snapA.dist > SNAP_MAX || snapB.dist > SNAP_MAX) return straight;

  // Pontos projetados na rua viram nós ligados às pontas do trecho de rua onde caíram
  const start = coords.length; coords.push(snapA.point); adj.push([]);
  adj[start].push([snapA.a, haversine(snapA.point, coords[snapA.a])], [snapA.b, haversine(snapA.point, coords[snapA.b])]);
  adj[snapA.a].push([start, haversine(snapA.point, coords[snapA.a])]); adj[snapA.b].push([start, haversine(snapA.point, coords[snapA.b])]);
  const goal = coords.length; coords.push(snapB.point); adj.push([]);
  for (const [x, d] of [[snapB.a, haversine(snapB.point, coords[snapB.a])], [snapB.b, haversine(snapB.point, coords[snapB.b])]] as [number, number][]) {
    adj[goal].push([x, d]); adj[x].push([goal, d]);
  }
  if (snapA.a === snapB.a && snapA.b === snapB.b) {
    // mesmo trecho de rua: basta ligar as duas projeções
    adj[start].push([goal, haversine(snapA.point, snapB.point)]);
  }

  const path = dijkstra(adj, start, goal);
  if (!path) return straight;
  const line: LngLat[] = [b.from, ...path.map((i) => coords[i]), b.to];
  const len = lengthOf(line);
  // Caminho pelas ruas muito maior que a distância direta não é plausível: fica a linha reta
  if (len > Math.max(b.meters * 2.5, b.meters + 600)) return straight;
  return { coordinates: dedupe(line), method: 'STREETS' };
}

function snap(p: LngLat, coords: LngLat[], edges: Array<[number, number]>) {
  // Projeção local em metros (válida para a área pequena consultada)
  const k = Math.cos((p[1] * Math.PI) / 180) * 111_320;
  const toXY = (c: LngLat): [number, number] => [(c[0] - p[0]) * k, (c[1] - p[1]) * 110_540];
  let best: { a: number; b: number; point: LngLat; dist: number } | null = null;
  for (const [a, z] of edges) {
    const A = toXY(coords[a]), B = toXY(coords[z]);
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 ? -(A[0] * dx + A[1] * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const x = A[0] + t * dx, y = A[1] + t * dy;
    const dist = Math.hypot(x, y);
    if (!best || dist < best.dist) best = { a, b: z, dist, point: [p[0] + x / k, p[1] + y / 110_540] };
  }
  return best;
}

function dijkstra(adj: Array<Array<[number, number]>>, start: number, goal: number): number[] | null {
  const dist = new Float64Array(adj.length).fill(Infinity);
  const prev = new Int32Array(adj.length).fill(-1);
  const heap: Array<[number, number]> = [];
  const push = (d: number, n: number) => {
    heap.push([d, n]);
    let i = heap.length - 1;
    while (i > 0) { const pa = (i - 1) >> 1; if (heap[pa][0] <= heap[i][0]) break; [heap[pa], heap[i]] = [heap[i], heap[pa]]; i = pa; }
  };
  const pop = () => {
    const top = heap[0]; const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
      }
    }
    return top;
  };
  dist[start] = 0; push(0, start);
  while (heap.length) {
    const [d, n] = pop();
    if (d > dist[n]) continue;
    if (n === goal) break;
    for (const [m, w] of adj[n]) {
      const nd = d + w;
      if (nd < dist[m]) { dist[m] = nd; prev[m] = n; push(nd, m); }
    }
  }
  if (!Number.isFinite(dist[goal])) return null;
  const out: number[] = [];
  for (let n = goal; n !== -1; n = prev[n]) out.push(n);
  return out.reverse();
}

function dedupe(line: LngLat[]): LngLat[] {
  return line.filter((c, i) => i === 0 || haversine(line[i - 1], c) > 0.5);
}
