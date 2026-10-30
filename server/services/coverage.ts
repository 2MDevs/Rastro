import { pool } from '../db';
import { getInt } from '../settings';
import { buildTrack, computeStreetCoverage, TrackParams, LngLat } from './geo';
import { newId } from '../auth/core';

export const METHODOLOGY_VERSION = 'v1';

export async function trackParams(): Promise<TrackParams> {
  return {
    maxAccuracyM: await getInt('COVERAGE_MAX_ACCURACY_M'),
    maxGapSeconds: await getInt('TRACK_MAX_GAP_SECONDS'),
    maxGapMeters: await getInt('TRACK_MAX_GAP_METERS'),
    maxSpeedKmh: await getInt('TRACK_MAX_SPEED_KMH'),
  };
}

export async function coverageParams() {
  return {
    bufferM: await getInt('COVERAGE_BUFFER_M'),
    donePct: await getInt('COVERAGE_STREET_DONE_PCT'),
    partialPct: await getInt('COVERAGE_STREET_PARTIAL_PCT'),
    minPoints: await getInt('COVERAGE_MIN_POINTS'),
  };
}

/** Percurso de uma sessão já tratado (trechos contínuos, distância e descartes) */
export async function sessionTrack(sessionId: string, params?: TrackParams) {
  const { rows } = await pool.query(
    `SELECT lat, lng, accuracy_m, captured_at, accepted FROM gps_points WHERE session_id = $1 ORDER BY captured_at, id`,
    [sessionId]
  );
  return buildTrack(rows, params ?? (await trackParams()));
}

/** Atualiza distância e pontos válidos guardados na sessão (usados em painéis e relatórios) */
export async function refreshSessionStats(sessionId: string, params?: TrackParams) {
  const t = await sessionTrack(sessionId, params);
  await pool.query('UPDATE tracking_sessions SET distance_m = $2, valid_points = $3, stats_updated_at = NOW() WHERE id = $1',
    [sessionId, t.distanceM, t.validPoints]);
  return t;
}

/**
 * Calcula (e guarda) a cobertura estimada de uma campanha.
 * Cada sessão vira trechos próprios: o trajeto de uma pessoa nunca é ligado ao de outra.
 */
export async function computeCampaignCoverage(campaignId: string, computedBy: string) {
  const tp = await trackParams();
  const cp = await coverageParams();
  const { rows: streets } = await pool.query(
    'SELECT id, name, geometry, length_m FROM planned_streets WHERE campaign_id = $1', [campaignId]
  );
  const { rows: sessions } = await pool.query('SELECT id FROM tracking_sessions WHERE campaign_id = $1', [campaignId]);

  const segments: LngLat[][] = [];
  let validPoints = 0, totalPoints = 0, distanceM = 0;
  for (const s of sessions) {
    const t = await refreshSessionStats(s.id, tp);
    segments.push(...t.segments);
    validPoints += t.validPoints;
    totalPoints += t.totalPoints;
    distanceM += t.distanceM;
  }

  const plannedLength = streets.reduce((a, s) => a + Number(s.length_m), 0);
  let status: 'OK' | 'INCONCLUSIVE' | 'NO_DATA' | 'NO_PLAN';
  let perStreet: ReturnType<typeof computeStreetCoverage> = [];
  let covered = 0;
  let percent: number | null = null;

  if (!streets.length) status = 'NO_PLAN';
  else if (validPoints === 0) status = 'NO_DATA';
  else if (validPoints < cp.minPoints) status = 'INCONCLUSIVE';
  else status = 'OK';

  if (streets.length && segments.length) {
    perStreet = computeStreetCoverage(
      streets.map((s) => ({ id: s.id, name: s.name, geometry: s.geometry, lengthM: Number(s.length_m) })),
      segments,
      cp
    );
    covered = perStreet.reduce((a, s) => a + s.coveredM, 0);
  } else if (streets.length) {
    perStreet = streets.map((s) => ({ id: s.id, name: s.name, lengthM: +Number(s.length_m).toFixed(1), coveredM: 0, coveredPct: 0, status: 'PENDING' as const }));
  }
  if (status === 'OK') percent = plannedLength > 0 ? +((covered / plannedLength) * 100).toFixed(1) : null;

  const id = newId('cob');
  await pool.query(
    `INSERT INTO coverage_results (id, campaign_id, computed_by, methodology_version, params, status, planned_length_m, covered_length_m,
       percent, streets, valid_points, total_points, sessions_count, distance_m)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, campaignId, computedBy, METHODOLOGY_VERSION, JSON.stringify({ ...tp, ...cp }), status, plannedLength,
      status === 'OK' ? covered : 0, percent, JSON.stringify(perStreet), validPoints, totalPoints, sessions.length, distanceM]
  );
  return latestCoverage(campaignId);
}

export function coverageDto(r: any) {
  if (!r) return null;
  const streets = (r.streets ?? []) as any[];
  return {
    id: r.id,
    computedAt: r.computed_at,
    methodologyVersion: r.methodology_version,
    params: r.params,
    status: r.status,
    plannedLengthM: Math.round(r.planned_length_m),
    coveredLengthM: Math.round(r.covered_length_m),
    percent: r.percent === null ? null : Number(r.percent),
    validPoints: r.valid_points,
    totalPoints: r.total_points,
    sessionsCount: r.sessions_count,
    distanceM: Math.round(r.distance_m),
    streetsSummary: {
      total: streets.length,
      done: streets.filter((s) => s.status === 'DONE').length,
      partial: streets.filter((s) => s.status === 'PARTIAL').length,
      pending: streets.filter((s) => s.status === 'PENDING').length,
    },
    streets,
  };
}

export async function latestCoverage(campaignId: string) {
  const { rows } = await pool.query(
    'SELECT * FROM coverage_results WHERE campaign_id = $1 ORDER BY computed_at DESC LIMIT 1', [campaignId]
  );
  return coverageDto(rows[0]);
}

// Recalcula em segundo plano, sem acumular pedidos para a mesma campanha
const pending = new Map<string, NodeJS.Timeout>();
export function scheduleCoverage(campaignId: string, by = 'Sistema (automático)', delayMs = 3000) {
  clearTimeout(pending.get(campaignId));
  const timer = setTimeout(() => {
    pending.delete(campaignId);
    computeCampaignCoverage(campaignId, by).catch((err) => console.error('[COBERTURA]', campaignId, err.message));
  }, delayMs);
  timer.unref?.();
  pending.set(campaignId, timer);
}
