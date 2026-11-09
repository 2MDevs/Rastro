import { LngLat } from './geo';

/**
 * Quantas vezes cada trecho de rua foi percorrido (mapa de calor do percurso).
 *
 * - O percurso é dividido em pedacinhos de até 10 m.
 * - Para cada pedacinho, contam-se as "passagens" que aconteceram a até 15 m dele: cada percurso
 *   (sessão) que passou por ali conta uma vez por ida — se a mesma pessoa voltou pela rua mais de
 *   90 segundos depois, é outra passagem (ida e volta = 2).
 * - Pedacinhos seguidos com o mesmo número viram uma linha só.
 * - Trechos estimados (sem sinal de GPS) não entram na contagem.
 */
export interface PassTrack { sessionId: string; segments: LngLat[][]; times: number[][] }
export interface PassRun { coords: LngLat[]; passes: number }

const STEP_M = 10;
const RADIUS_M = 15;
const REVISIT_MS = 90_000;
export const MAX_PASS_LEVEL = 5;

interface Piece { a: LngLat; b: LngLat; x: number; y: number; t: number; s: number }

export function computePasses(tracks: PassTrack[]): Map<string, PassRun[]> {
  const out = new Map<string, PassRun[]>();
  const first = tracks.find((t) => t.segments[0]?.[0])?.segments[0][0];
  if (!first) return out;
  const kx = Math.cos((first[1] * Math.PI) / 180) * 111_320;
  const ky = 110_540;
  const xy = (c: LngLat): [number, number] => [c[0] * kx, c[1] * ky];

  // 1) pedacinhos de até 10 m, com o horário interpolado
  const sessionIdx = new Map<string, number>();
  const piecesBySeg: { sessionId: string; pieces: Piece[] }[] = [];
  const all: Piece[] = [];
  for (const tr of tracks) {
    const s = sessionIdx.get(tr.sessionId) ?? sessionIdx.set(tr.sessionId, sessionIdx.size).get(tr.sessionId)!;
    tr.segments.forEach((seg, si) => {
      const times = tr.times[si] ?? [];
      const pieces: Piece[] = [];
      for (let i = 1; i < seg.length; i++) {
        const [ax, ay] = xy(seg[i - 1]), [bx, by] = xy(seg[i]);
        const len = Math.hypot(bx - ax, by - ay);
        const n = Math.max(1, Math.ceil(len / STEP_M));
        const t0 = times[i - 1] ?? 0, t1 = times[i] ?? t0;
        for (let k = 0; k < n; k++) {
          const f0 = k / n, f1 = (k + 1) / n;
          const a: LngLat = [seg[i - 1][0] + (seg[i][0] - seg[i - 1][0]) * f0, seg[i - 1][1] + (seg[i][1] - seg[i - 1][1]) * f0];
          const b: LngLat = [seg[i - 1][0] + (seg[i][0] - seg[i - 1][0]) * f1, seg[i - 1][1] + (seg[i][1] - seg[i - 1][1]) * f1];
          const fm = (f0 + f1) / 2;
          const p: Piece = { a, b, x: ax + (bx - ax) * fm, y: ay + (by - ay) * fm, t: t0 + (t1 - t0) * fm, s };
          pieces.push(p); all.push(p);
        }
      }
      piecesBySeg.push({ sessionId: tr.sessionId, pieces });
    });
  }

  // 2) grade espacial para achar os vizinhos a até 15 m
  const cell = (v: number) => Math.floor(v / RADIUS_M);
  const grid = new Map<string, Piece[]>();
  for (const p of all) {
    const k = `${cell(p.x)}:${cell(p.y)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(p);
  }
  const r2 = RADIUS_M * RADIUS_M;
  const passesAt = (p: Piece) => {
    const near: Piece[] = [];
    const cx = cell(p.x), cy = cell(p.y);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const q of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
        if ((q.x - p.x) ** 2 + (q.y - p.y) ** 2 <= r2) near.push(q);
      }
    }
    // cada sessão: horários próximos (até 90 s entre um e outro) são a mesma passagem
    near.sort((u, v) => u.s - v.s || u.t - v.t);
    let count = 0;
    for (let i = 0; i < near.length; i++) {
      if (i === 0 || near[i].s !== near[i - 1].s || near[i].t - near[i - 1].t > REVISIT_MS) count++;
    }
    return Math.max(1, Math.min(MAX_PASS_LEVEL, count));
  };

  // 3) junta pedacinhos seguidos com o mesmo número de passagens
  for (const { sessionId, pieces } of piecesBySeg) {
    const runs = out.get(sessionId) ?? out.set(sessionId, []).get(sessionId)!;
    let run: PassRun | null = null;
    for (const p of pieces) {
      const n = passesAt(p);
      if (run && run.passes === n) run.coords.push(p.b);
      else {
        run = { coords: [p.a, p.b], passes: n };
        runs.push(run);
      }
    }
  }
  return out;
}
