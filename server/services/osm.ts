import { getValue } from '../settings';
import { HttpError } from '../http';
import { clipLineToPolygon, lineLength, LngLat, PolygonGeom, simplifyLine } from './geo';

/**
 * Integrações com serviços do OpenStreetMap:
 * - Overpass API: ruas dentro de um território (para planejar a panfletagem);
 * - Nominatim: busca de endereço (para posicionar a loja).
 * Os endereços dos serviços são configuráveis na tela Integração.
 */

const USER_AGENT = 'RASTRO/1.0 (Hummm! Pizzas - TI; plataforma interna de planejamento territorial)';

/** Tipos de via em que faz sentido panfletar (vias expressas e rodovias ficam de fora) */
export const STREET_TYPES: Record<string, string> = {
  residential: 'Rua residencial',
  living_street: 'Rua de pedestres e moradores',
  tertiary: 'Via coletora',
  tertiary_link: 'Via coletora (acesso)',
  secondary: 'Via arterial secundária',
  secondary_link: 'Via arterial secundária (acesso)',
  primary: 'Avenida principal',
  primary_link: 'Avenida principal (acesso)',
  unclassified: 'Via local',
  pedestrian: 'Calçadão',
  service: 'Via de serviço / acesso',
};

export interface StreetPiece {
  osmWayId: number;
  piece: number;
  name: string | null;
  highway: string;
  coordinates: LngLat[];
  lengthM: number;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, headers: { 'User-Agent': USER_AGENT, ...(init.headers || {}) } });
  } finally {
    clearTimeout(t);
  }
}

export async function fetchStreetsInArea(area: PolygonGeom, includeService: boolean): Promise<StreetPiece[]> {
  const url = await getValue('OVERPASS_URL');
  if (!url) throw new HttpError(503, 'O serviço de ruas (Overpass) não está configurado na tela Integração.');
  let ring = area.coordinates[0];
  // O Overpass aceita polígonos simples: reduz pontos mantendo a forma (tolerância de 5 m, depois 15 m)
  ring = simplifyLine(ring, 5);
  if (ring.length > 250) ring = simplifyLine(ring, 15);
  const poly = ring.map(([lng, lat]) => `${lat.toFixed(6)} ${lng.toFixed(6)}`).join(' ');
  const types = Object.keys(STREET_TYPES).filter((t) => includeService || t !== 'service').join('|');
  const query = `[out:json][timeout:60];way["highway"~"^(${types})$"](poly:"${poly}");out tags geom;`;

  let resp: Response;
  try {
    resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data: query }).toString(),
    }, 75_000);
  } catch {
    throw new HttpError(504, 'O serviço de ruas não respondeu a tempo. Tente de novo em alguns minutos.');
  }
  if (resp.status === 429) throw new HttpError(503, 'O serviço de ruas está ocupado (limite de consultas). Tente de novo em alguns minutos.');
  if (!resp.ok) throw new HttpError(502, `O serviço de ruas respondeu com erro (${resp.status}). Tente de novo mais tarde.`);
  let data: any;
  try {
    data = await resp.json();
  } catch {
    throw new HttpError(502, 'O serviço de ruas devolveu uma resposta inválida.');
  }
  const pieces: StreetPiece[] = [];
  for (const el of data?.elements ?? []) {
    if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;
    const line: LngLat[] = el.geometry
      .filter((g: any) => Number.isFinite(g?.lat) && Number.isFinite(g?.lon))
      .map((g: any) => [g.lon, g.lat]);
    if (line.length < 2) continue;
    clipLineToPolygon(line, area).forEach((coords, i) => {
      pieces.push({
        osmWayId: Number(el.id),
        piece: i,
        name: typeof el.tags?.name === 'string' ? el.tags.name.slice(0, 200) : null,
        highway: String(el.tags?.highway || 'unclassified'),
        coordinates: coords,
        lengthM: lineLength(coords),
      });
    });
  }
  return pieces;
}

// ---------------------------------------------------------------- busca de endereços (Nominatim)
let lastGeocodeAt = 0;
let queue = Promise.resolve();

/** Respeita 1 consulta por segundo (política do Nominatim público), em fila */
function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastGeocodeAt + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastGeocodeAt = Date.now();
    return fn();
  });
  queue = run.then(() => undefined, () => undefined);
  return run;
}

export interface GeocodeResult { label: string; lat: number; lng: number; type: string }

export async function geocode(q: string): Promise<GeocodeResult[]> {
  const base = (await getValue('NOMINATIM_URL')).replace(/\/$/, '');
  if (!base) throw new HttpError(503, 'O serviço de busca de endereços não está configurado na tela Integração.');
  return throttle(async () => {
    const url = `${base}/search?${new URLSearchParams({ q, format: 'jsonv2', limit: '6', countrycodes: 'br', 'accept-language': 'pt-BR', addressdetails: '0' })}`;
    let resp: Response;
    try {
      resp = await fetchWithTimeout(url, {}, 12_000);
    } catch {
      throw new HttpError(504, 'A busca de endereços não respondeu. Você também pode clicar no mapa para marcar o local.');
    }
    if (!resp.ok) throw new HttpError(502, 'A busca de endereços está indisponível agora. Você pode clicar no mapa para marcar o local.');
    const data = (await resp.json().catch(() => [])) as any[];
    return data
      .filter((d) => Number.isFinite(+d.lat) && Number.isFinite(+d.lon))
      .map((d) => ({ label: String(d.display_name || '').slice(0, 300), lat: +d.lat, lng: +d.lon, type: String(d.type || '') }));
  });
}
