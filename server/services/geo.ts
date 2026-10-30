/**
 * Cálculos geográficos do RASTRO (sem dependências externas).
 * Coordenadas no padrão GeoJSON: [longitude, latitude]. Distâncias em metros.
 *
 * Para distâncias curtas (escala de bairro) usamos uma projeção local plana
 * (equiretangular centrada na região), com erro desprezível para a operação.
 */

export type LngLat = [number, number];
export type Ring = LngLat[];
export interface PolygonGeom { type: 'Polygon'; coordinates: Ring[] }
export interface LineGeom { type: 'LineString'; coordinates: LngLat[] }

const R = 6_371_008.8;
const RAD = Math.PI / 180;

export function haversine(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLng = (b[0] - a[0]) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function isLngLat(p: unknown): p is LngLat {
  return Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])
    && Math.abs(p[0] as number) <= 180 && Math.abs(p[1] as number) <= 90;
}

/** Projeção local: metros a partir de um ponto de referência */
export class LocalProjection {
  private k: number;
  constructor(private lat0: number, private lng0: number) {
    this.k = Math.cos(lat0 * RAD);
  }
  toXY(p: LngLat): [number, number] {
    return [(p[0] - this.lng0) * RAD * R * this.k, (p[1] - this.lat0) * RAD * R];
  }
  toLngLat(x: number, y: number): LngLat {
    return [this.lng0 + x / (RAD * R * this.k), this.lat0 + y / (RAD * R)];
  }
}

export function lineLength(coords: LngLat[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += haversine(coords[i - 1], coords[i]);
  return total;
}

export function bboxOf(coords: LngLat[]): { minLng: number; minLat: number; maxLng: number; maxLat: number } {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const [lng, lat] of coords) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLng, minLat, maxLng, maxLat };
}

/** Polígono aproximando um círculo (raio em metros) */
export function circlePolygon(center: LngLat, radiusM: number, steps = 72): PolygonGeom {
  const proj = new LocalProjection(center[1], center[0]);
  const ring: Ring = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    const p = proj.toLngLat(Math.cos(a) * radiusM, Math.sin(a) * radiusM);
    ring.push([+p[0].toFixed(7), +p[1].toFixed(7)]);
  }
  ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
}

function ringAreaXY(ring: [number, number][]): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(s) / 2;
}

export function polygonArea(poly: PolygonGeom): number {
  const outer = poly.coordinates[0];
  const c = bboxOf(outer);
  const proj = new LocalProjection((c.minLat + c.maxLat) / 2, (c.minLng + c.maxLng) / 2);
  const [first, ...holes] = poly.coordinates.map((r) => ringAreaXY(r.map((p) => proj.toXY(p))));
  return Math.max(0, first - holes.reduce((a, b) => a + b, 0));
}

export function pointInRing(p: LngLat, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(p: LngLat, poly: PolygonGeom): boolean {
  if (!pointInRing(p, poly.coordinates[0])) return false;
  return !poly.coordinates.slice(1).some((hole) => pointInRing(p, hole));
}

function segmentsCross(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const o = (p: [number, number], q: [number, number], r: [number, number]) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

/**
 * Valida um perímetro desenhado. Devolve o polígono normalizado (anel fechado) ou lança Error com
 * mensagem em português.
 */
export function normalizePolygon(input: unknown, maxVertices = 400): PolygonGeom {
  const g = input as any;
  if (!g || g.type !== 'Polygon' || !Array.isArray(g.coordinates) || !Array.isArray(g.coordinates[0])) {
    throw new Error('O perímetro precisa ser um polígono.');
  }
  if (g.coordinates.length > 1) throw new Error('O perímetro não pode ter buracos.');
  const ring: Ring = g.coordinates[0].map((p: unknown) => {
    if (!isLngLat(p)) throw new Error('O perímetro tem coordenadas inválidas.');
    return [+(p as LngLat)[0].toFixed(7), +(p as LngLat)[1].toFixed(7)] as LngLat;
  });
  const first = ring[0], last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  // remove pontos repetidos em sequência
  const clean: Ring = [ring[0]];
  for (const p of ring.slice(1)) {
    const q = clean[clean.length - 1];
    if (p[0] !== q[0] || p[1] !== q[1]) clean.push(p);
  }
  if (clean.length < 4) throw new Error('Desenhe pelo menos 3 pontos para formar o perímetro.');
  if (clean.length - 1 > maxVertices) throw new Error(`O perímetro tem pontos demais (máximo ${maxVertices}).`);
  const bb = bboxOf(clean);
  const proj = new LocalProjection((bb.minLat + bb.maxLat) / 2, (bb.minLng + bb.maxLng) / 2);
  const xy = clean.map((p) => proj.toXY(p));
  const n = xy.length - 1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsCross(xy[i], xy[i + 1], xy[j], xy[j + 1])) throw new Error('As linhas do perímetro se cruzam. Desenhe sem cruzar as bordas.');
    }
  }
  const poly: PolygonGeom = { type: 'Polygon', coordinates: [clean] };
  const area = polygonArea(poly);
  if (area < 100) throw new Error('O perímetro é pequeno demais.');
  if (area > 2_000_000_000) throw new Error('O perímetro é grande demais (mais de 2.000 km²).');
  return poly;
}

/** Douglas-Peucker em metros (para reduzir pontos antes de consultas externas) */
export function simplifyLine(coords: LngLat[], toleranceM: number): LngLat[] {
  if (coords.length < 3) return coords;
  const bb = bboxOf(coords);
  const proj = new LocalProjection((bb.minLat + bb.maxLat) / 2, (bb.minLng + bb.maxLng) / 2);
  const xy = coords.map((p) => proj.toXY(p));
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack: [number, number][] = [[0, coords.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = distPointSeg(xy[i], xy[s], xy[e]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > toleranceM && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}

export function distPointSeg(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx - p[0], y = a[1] + t * dy - p[1];
  return Math.sqrt(x * x + y * y);
}

// =================================================================== trajetos
export interface TrackPoint {
  lat: number;
  lng: number;
  accuracy_m: number | null;
  captured_at: string | Date;
  accepted: boolean;
}

export interface TrackParams {
  maxAccuracyM: number;
  maxGapSeconds: number;
  maxGapMeters: number;
  maxSpeedKmh: number;
}

export interface TrackResult {
  /** Trechos contínuos (cada um é uma linha); intervalos sem sinal ficam fora */
  segments: LngLat[][];
  distanceM: number;
  validPoints: number;
  totalPoints: number;
  discarded: { lowAccuracy: number; rejected: number; jumps: number };
  gaps: number;
}

/**
 * Monta o percurso a partir dos pontos brutos, sem inventar trajeto:
 * - descarta pontos recusados e com precisão pior que o limite;
 * - descarta saltos impossíveis (velocidade acima do limite);
 * - interrompe a linha quando o intervalo de tempo ou distância entre pontos é grande demais.
 */
export function buildTrack(points: TrackPoint[], p: TrackParams): TrackResult {
  const sorted = [...points].sort((a, b) => +new Date(a.captured_at) - +new Date(b.captured_at));
  const res: TrackResult = { segments: [], distanceM: 0, validPoints: 0, totalPoints: points.length, discarded: { lowAccuracy: 0, rejected: 0, jumps: 0 }, gaps: 0 };
  let current: LngLat[] = [];
  let lastT = 0;
  let skipped = 0;
  const maxSpeed = p.maxSpeedKmh / 3.6;

  const close = () => {
    if (current.length >= 2) {
      res.segments.push(current);
      res.distanceM += lineLength(current);
    }
    current = [];
  };

  for (const pt of sorted) {
    if (!pt.accepted) { res.discarded.rejected++; continue; }
    if (pt.accuracy_m === null || pt.accuracy_m === undefined || pt.accuracy_m > p.maxAccuracyM) { res.discarded.lowAccuracy++; continue; }
    const here: LngLat = [pt.lng, pt.lat];
    const t = +new Date(pt.captured_at);
    if (current.length === 0) {
      current.push(here); lastT = t; skipped = 0; res.validPoints++;
      continue;
    }
    const prev = current[current.length - 1];
    const dt = (t - lastT) / 1000;
    const dist = haversine(prev, here);
    if (dt > p.maxGapSeconds || (dist > p.maxGapMeters && dt > 0 && dist / dt <= maxSpeed)) {
      // intervalo grande: novo trecho, sem ligar os pontos
      close(); res.gaps++;
      current.push(here); lastT = t; skipped = 0; res.validPoints++;
      continue;
    }
    if (dt <= 0 ? dist > 5 : dist / dt > maxSpeed || dist > p.maxGapMeters) {
      // salto impossível: provável erro de sinal. Depois de 3 seguidos, recomeça a partir daqui.
      skipped++;
      res.discarded.jumps++;
      if (skipped >= 3) {
        close(); res.gaps++;
        current.push(here); lastT = t; skipped = 0; res.validPoints++; res.discarded.jumps--;
      }
      continue;
    }
    skipped = 0;
    if (dist < 0.5) { lastT = t; res.validPoints++; continue; } // parado: não duplica vértice
    current.push(here); lastT = t; res.validPoints++;
  }
  close();
  return res;
}

// =================================================================== cobertura
export interface CoverageStreet {
  id: string;
  name: string | null;
  geometry: LineGeom;
  lengthM: number;
}

export interface CoverageParams {
  bufferM: number;
  donePct: number;
  partialPct: number;
}

export interface StreetCoverage {
  id: string;
  name: string | null;
  lengthM: number;
  coveredM: number;
  coveredPct: number;
  status: 'DONE' | 'PARTIAL' | 'PENDING';
}

/** Índice espacial simples (grade) das arestas dos trajetos */
class EdgeGrid {
  private cells = new Map<string, number[]>();
  private edges: [[number, number], [number, number]][] = [];
  constructor(private size: number) {}
  add(a: [number, number], b: [number, number]) {
    const id = this.edges.push([a, b]) - 1;
    const x0 = Math.floor(Math.min(a[0], b[0]) / this.size), x1 = Math.floor(Math.max(a[0], b[0]) / this.size);
    const y0 = Math.floor(Math.min(a[1], b[1]) / this.size), y1 = Math.floor(Math.max(a[1], b[1]) / this.size);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const k = `${x}:${y}`;
      const list = this.cells.get(k);
      if (list) list.push(id); else this.cells.set(k, [id]);
    }
  }
  near(p: [number, number], radius: number): boolean {
    const cx = Math.floor(p[0] / this.size), cy = Math.floor(p[1] / this.size);
    const seen = new Set<number>();
    for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) {
      for (const id of this.cells.get(`${x}:${y}`) ?? []) {
        if (seen.has(id)) continue;
        seen.add(id);
        const [a, b] = this.edges[id];
        if (distPointSeg(p, a, b) <= radius) return true;
      }
    }
    return false;
  }
}

/**
 * Metodologia v1 (documentada em docs/metodologia-cobertura.md):
 * cada rua planejada é amostrada a cada poucos metros; uma amostra conta como percorrida quando
 * algum trecho do percurso válido passou a até `bufferM` metros dela. A cobertura da rua é a
 * fração das amostras percorridas, aplicada ao comprimento da rua.
 */
export function computeStreetCoverage(streets: CoverageStreet[], segments: LngLat[][], p: CoverageParams): StreetCoverage[] {
  const all = streets.flatMap((s) => s.geometry.coordinates);
  if (!all.length) return [];
  const bb = bboxOf(all);
  const proj = new LocalProjection((bb.minLat + bb.maxLat) / 2, (bb.minLng + bb.maxLng) / 2);
  const grid = new EdgeGrid(Math.max(p.bufferM, 10));
  for (const seg of segments) {
    for (let i = 1; i < seg.length; i++) grid.add(proj.toXY(seg[i - 1]), proj.toXY(seg[i]));
  }
  const step = Math.max(1, Math.min(5, p.bufferM / 3));
  return streets.map((s) => {
    const xy = s.geometry.coordinates.map((c) => proj.toXY(c));
    let samples = 0, hit = 0;
    for (let i = 1; i < xy.length; i++) {
      const [a, b] = [xy[i - 1], xy[i]];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(len / step));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        samples++;
        if (grid.near([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], p.bufferM)) hit++;
      }
    }
    const frac = samples ? hit / samples : 0;
    const pct = +(frac * 100).toFixed(1);
    return {
      id: s.id,
      name: s.name,
      lengthM: +s.lengthM.toFixed(1),
      coveredM: +(s.lengthM * frac).toFixed(1),
      coveredPct: pct,
      status: pct >= p.donePct ? 'DONE' : pct >= p.partialPct ? 'PARTIAL' : 'PENDING',
    };
  });
}

// =================================================================== recorte de vias pelo território
function segIntersectionT(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): number | null {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t > 1e-9 && t < 1 - 1e-9 && u >= 0 && u <= 1 ? t : null;
}

/**
 * Recorta uma linha pelo polígono: devolve só os pedaços que ficam dentro do território
 * (uma rua que sai e volta vira mais de um pedaço).
 */
export function clipLineToPolygon(line: LngLat[], poly: PolygonGeom, minLengthM = 5): LngLat[][] {
  const ring = poly.coordinates[0];
  const bb = bboxOf(ring);
  const proj = new LocalProjection((bb.minLat + bb.maxLat) / 2, (bb.minLng + bb.maxLng) / 2);
  const ringXY = ring.map((p) => proj.toXY(p));
  // divide cada trecho nos pontos onde cruza a borda
  const pts: LngLat[] = [];
  for (let i = 0; i < line.length - 1; i++) {
    const a = proj.toXY(line[i]), b = proj.toXY(line[i + 1]);
    const ts: number[] = [];
    for (let k = 0; k < ringXY.length - 1; k++) {
      const t = segIntersectionT(a, b, ringXY[k], ringXY[k + 1]);
      if (t !== null) ts.push(t);
    }
    pts.push(line[i]);
    for (const t of ts.sort((x, y) => x - y)) {
      pts.push(proj.toLngLat(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t));
    }
  }
  pts.push(line[line.length - 1]);
  const pieces: LngLat[][] = [];
  let cur: LngLat[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const mid: LngLat = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2];
    if (pointInPolygon(mid, poly)) {
      if (!cur.length) cur.push(pts[i]);
      cur.push(pts[i + 1]);
    } else if (cur.length) {
      pieces.push(cur);
      cur = [];
    }
  }
  if (cur.length) pieces.push(cur);
  return pieces
    .map((p) => p.map((c) => [+c[0].toFixed(7), +c[1].toFixed(7)] as LngLat))
    .filter((p) => p.length >= 2 && lineLength(p) >= minLengthM);
}
