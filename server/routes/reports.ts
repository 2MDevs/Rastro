import { Router, Request } from 'express';
import { pool } from '../db';
import { h, HttpError, sendCsv } from '../http';
import { audit } from '../audit';
import { requireAuth, requireCapability, userOf } from '../auth/core';
import { assertStoreAccess, can, scopeSql, SessionUser } from '../access';
import { refreshSessionStats } from '../services/coverage';
import { CAMPAIGN_STATUS_LABEL } from './campaigns';
import { sessionState, SESSION_STATE_LABEL } from './tracking';
import { getInt } from '../settings';

export const reportsRouter = Router();
reportsRouter.use(requireAuth({ apiKeyScopes: ['reports:read'] }));

const isDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

interface Filters { storeIds: string[] | null; from: string | null; to: string | null; campaignId: string | null; userId: string | null; status: string | null }

function readFilters(user: SessionUser, q: any): Filters {
  let storeIds: string[] | null = null;
  const raw = q.storeIds ?? q.storeId;
  if (raw) {
    storeIds = String(raw).split(',').filter(Boolean).slice(0, 500);
    storeIds.forEach((id) => assertStoreAccess(user, id));
  }
  if (q.from && !isDate(q.from)) throw new HttpError(400, 'Data inicial inválida.');
  if (q.to && !isDate(q.to)) throw new HttpError(400, 'Data final inválida.');
  return {
    storeIds, from: q.from || null, to: q.to || null,
    campaignId: q.campaignId ? String(q.campaignId) : null,
    userId: q.userId ? String(q.userId) : null,
    status: q.status ? String(q.status) : null,
  };
}

function periodLabel(f: Filters) {
  const br = (d: string) => d.split('-').reverse().join('/');
  if (f.from && f.to) return `${br(f.from)} a ${br(f.to)}`;
  if (f.from) return `desde ${br(f.from)}`;
  if (f.to) return `até ${br(f.to)}`;
  return 'todo o período';
}

// ---------------------------------------------------------------- painel (Matriz ou loja)
async function computeDashboard(user: SessionUser, f: Filters) {
  const p: unknown[] = [];
  let storeWhere = scopeSql(user, 's.id', p);
  if (f.storeIds) { p.push(f.storeIds); storeWhere += ` AND s.id = ANY($${p.length}::text[])`; }

  const stores = await pool.query(
    `SELECT s.id, s.code, s.name, s.status, s.lat, s.lng,
       (SELECT COUNT(*) FROM campaigns c WHERE c.store_id = s.id AND c.status = 'ACTIVE') AS active_campaigns,
       (SELECT COUNT(*) FROM tracking_sessions t WHERE t.store_id = s.id AND t.status = 'IN_PROGRESS') AS live_sessions,
       (SELECT COUNT(*) FROM coverage_areas a WHERE a.store_id = s.id AND a.archived_at IS NULL) AS areas,
       (SELECT MAX(t.last_point_received_at) FROM tracking_sessions t WHERE t.store_id = s.id) AS last_activity_at
     FROM stores s WHERE ${storeWhere} ORDER BY s.name`, p
  );
  const storeIds = stores.rows.map((s) => s.id);

  const sp: unknown[] = [storeIds];
  let sessWhere = 't.store_id = ANY($1::text[])';
  if (f.from) { sp.push(f.from); sessWhere += ` AND t.started_at >= $${sp.length}::date`; }
  if (f.to) { sp.push(f.to); sessWhere += ` AND t.started_at < ($${sp.length}::date + 1)`; }
  if (!can(user.role, 'tracking.view')) { sp.push(user.id); sessWhere += ` AND t.user_id = $${sp.length}`; }

  // Sessões ainda sem estatística (em andamento ou recém-chegadas): calcula agora
  const { rows: stale } = await pool.query(
    `SELECT t.id FROM tracking_sessions t WHERE ${sessWhere} AND (t.stats_updated_at IS NULL OR t.status = 'IN_PROGRESS' OR t.stats_updated_at < t.last_point_received_at) LIMIT 50`, sp
  );
  for (const s of stale) await refreshSessionStats(s.id);

  const sessions = await pool.query(
    `SELECT t.store_id, COUNT(*)::int AS sessions, COALESCE(SUM(t.distance_m), 0) AS distance_m,
            COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(t.finished_at, t.last_point_captured_at, t.started_at) - t.started_at))), 0) AS seconds,
            COUNT(DISTINCT t.user_id)::int AS people
       FROM tracking_sessions t WHERE ${sessWhere} GROUP BY t.store_id`, sp
  );
  const campaigns = await pool.query(
    `SELECT c.store_id, c.status, COUNT(*)::int AS n FROM campaigns c WHERE c.store_id = ANY($1::text[]) GROUP BY c.store_id, c.status`, [storeIds]
  );
  // Cobertura: último cálculo de cada campanha ativa, pausada ou concluída
  const coverage = await pool.query(
    `SELECT DISTINCT ON (c.id) c.id, c.store_id, c.status AS campaign_status, r.status, r.planned_length_m, r.covered_length_m, r.percent
       FROM campaigns c LEFT JOIN coverage_results r ON r.campaign_id = c.id
      WHERE c.store_id = ANY($1::text[]) AND c.status IN ('ACTIVE','PAUSED','FINISHED')
      ORDER BY c.id, r.computed_at DESC NULLS LAST`, [storeIds]
  );

  const perStore = new Map<string, any>(stores.rows.map((s) => [s.id, {
    id: s.id, code: s.code, name: s.name, status: s.status, location: s.lat === null ? null : { lat: s.lat, lng: s.lng },
    activeCampaigns: Number(s.active_campaigns), liveSessions: Number(s.live_sessions), areas: Number(s.areas), lastActivityAt: s.last_activity_at,
    sessions: 0, distanceM: 0, fieldSeconds: 0, people: 0, plannedM: 0, coveredM: 0, campaignsMeasured: 0, campaignsInconclusive: 0,
  }]));
  for (const r of sessions.rows) Object.assign(perStore.get(r.store_id), { sessions: r.sessions, distanceM: Math.round(r.distance_m), fieldSeconds: Math.round(r.seconds), people: r.people });
  for (const r of coverage.rows) {
    const s = perStore.get(r.store_id);
    if (r.status === 'OK') { s.plannedM += Number(r.planned_length_m); s.coveredM += Number(r.covered_length_m); s.campaignsMeasured++; }
    else s.campaignsInconclusive++;
  }
  const list = [...perStore.values()].map((s) => ({
    ...s,
    plannedM: Math.round(s.plannedM), coveredM: Math.round(s.coveredM),
    coveragePercent: s.plannedM > 0 ? +((s.coveredM / s.plannedM) * 100).toFixed(1) : null,
  }));
  const byStatus: Record<string, number> = {};
  for (const r of campaigns.rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + r.n;
  const totalPlanned = list.reduce((a, s) => a + s.plannedM, 0);
  const totalCovered = list.reduce((a, s) => a + s.coveredM, 0);

  return {
    period: { from: f.from, to: f.to, label: periodLabel(f) },
    totals: {
      stores: list.length,
      storesWithLocation: list.filter((s) => s.location).length,
      storesOperating: list.filter((s) => s.activeCampaigns > 0).length,
      liveSessions: list.reduce((a, s) => a + s.liveSessions, 0),
      campaignsByStatus: Object.fromEntries(Object.keys(CAMPAIGN_STATUS_LABEL).map((k) => [k, byStatus[k] ?? 0])),
      sessions: list.reduce((a, s) => a + s.sessions, 0),
      distanceM: list.reduce((a, s) => a + s.distanceM, 0),
      fieldSeconds: list.reduce((a, s) => a + s.fieldSeconds, 0),
      coverage: {
        plannedM: totalPlanned, coveredM: totalCovered,
        percent: totalPlanned > 0 ? +((totalCovered / totalPlanned) * 100).toFixed(1) : null,
        campaignsMeasured: list.reduce((a, s) => a + s.campaignsMeasured, 0),
        campaignsInconclusive: list.reduce((a, s) => a + s.campaignsInconclusive, 0),
      },
    },
    stores: list,
  };
}

reportsRouter.get('/dashboard', h(async (req, res) => {
  const user = userOf(req);
  return res.json(await computeDashboard(user, readFilters(user, req.query)));
}));

/** Comparação entre lojas (mesmos números do painel, linha por loja) */
reportsRouter.get('/stores', requireCapability('reports.view'), h(async (req, res) => {
  const user = userOf(req);
  const f = readFilters(user, req.query);
  const d = await computeDashboard(user, f);
  if (req.query.format === 'csv') {
    await exportAudit(req, 'Comparação entre lojas', d.stores.length, f);
    return sendCsv(res, 'rastro-comparacao-lojas.csv',
      ['loja', 'codigo', 'campanhas_ativas', 'sessoes', 'pessoas', 'distancia_m', 'horas_em_campo', 'metros_planejados', 'metros_percorridos', 'cobertura_estimada_pct', 'campanhas_sem_calculo_valido'],
      d.stores.map((s) => [s.name, s.code, s.activeCampaigns, s.sessions, s.people, s.distanceM, +(s.fieldSeconds / 3600).toFixed(1), s.plannedM, s.coveredM, s.coveragePercent, s.campaignsInconclusive]));
  }
  return res.json({ period: d.period.label, rows: d.stores });
}));

// ---------------------------------------------------------------- relatórios (JSON ou CSV)
async function exportAudit(req: Request, name: string, rows: number, f: Filters) {
  await audit(req, { action: 'REPORT_EXPORTED', targetType: 'report', targetName: name, details: `${rows} linha(s). Período: ${periodLabel(f)}.` });
}

reportsRouter.get('/sessions', requireCapability('reports.view'), h(async (req, res) => {
  const user = userOf(req);
  const f = readFilters(user, req.query);
  const p: unknown[] = [];
  let w = scopeSql(user, 't.store_id', p);
  if (f.storeIds) { p.push(f.storeIds); w += ` AND t.store_id = ANY($${p.length}::text[])`; }
  if (f.from) { p.push(f.from); w += ` AND t.started_at >= $${p.length}::date`; }
  if (f.to) { p.push(f.to); w += ` AND t.started_at < ($${p.length}::date + 1)`; }
  if (f.campaignId) { p.push(f.campaignId); w += ` AND t.campaign_id = $${p.length}`; }
  if (f.userId) { p.push(f.userId); w += ` AND t.user_id = $${p.length}`; }
  if (f.status) { p.push(f.status); w += ` AND t.status = $${p.length}`; }
  const { rows: stale } = await pool.query(`SELECT t.id FROM tracking_sessions t WHERE ${w} AND (t.stats_updated_at IS NULL OR t.status = 'IN_PROGRESS') LIMIT 100`, p);
  for (const s of stale) await refreshSessionStats(s.id);
  const { rows } = await pool.query(
    `SELECT t.*, u.name AS user_name, c.name AS campaign_name, s.name AS store_name, s.code AS store_code
       FROM tracking_sessions t JOIN users u ON u.id = t.user_id JOIN campaigns c ON c.id = t.campaign_id JOIN stores s ON s.id = t.store_id
      WHERE ${w} ORDER BY t.started_at DESC LIMIT 5000`, p
  );
  const staleMin = await getInt('TRACKING_STALE_MINUTES');
  const data = rows.map((r) => {
    const end = r.finished_at ?? r.last_point_captured_at;
    return {
      id: r.id, store: `${r.store_name} (${r.store_code})`, campaign: r.campaign_name, person: r.user_name,
      startedAt: r.started_at, finishedAt: r.finished_at,
      durationMinutes: end ? Math.round((new Date(end).getTime() - new Date(r.started_at).getTime()) / 60000) : null,
      distanceM: Math.round(r.distance_m), points: r.points_count, validPoints: r.valid_points,
      state: SESSION_STATE_LABEL[sessionState(r, staleMin)],
    };
  });
  if (req.query.format === 'csv') {
    await exportAudit(req, 'Histórico de percursos', data.length, f);
    return sendCsv(res, 'rastro-percursos.csv',
      ['loja', 'campanha', 'responsavel', 'inicio', 'fim', 'duracao_min', 'distancia_m', 'pontos_recebidos', 'pontos_validos', 'situacao'],
      data.map((d) => [d.store, d.campaign, d.person, d.startedAt && new Date(d.startedAt).toISOString(), d.finishedAt && new Date(d.finishedAt).toISOString(),
        d.durationMinutes, d.distanceM, d.points, d.validPoints, d.state]));
  }
  return res.json({ period: periodLabel(f), rows: data });
}));

reportsRouter.get('/coverage', requireCapability('reports.view'), h(async (req, res) => {
  const user = userOf(req);
  const f = readFilters(user, req.query);
  const p: unknown[] = [];
  let w = scopeSql(user, 'c.store_id', p);
  if (f.storeIds) { p.push(f.storeIds); w += ` AND c.store_id = ANY($${p.length}::text[])`; }
  if (f.campaignId) { p.push(f.campaignId); w += ` AND c.id = $${p.length}`; }
  if (f.status) { p.push(f.status); w += ` AND c.status = $${p.length}`; }
  if (f.from) { p.push(f.from); w += ` AND (c.end_date IS NULL OR c.end_date >= $${p.length}::date)`; }
  if (f.to) { p.push(f.to); w += ` AND (c.start_date IS NULL OR c.start_date <= $${p.length}::date)`; }
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.status, c.start_date, c.end_date, s.name AS store_name, s.code AS store_code,
       (SELECT COUNT(*) FROM planned_streets ps WHERE ps.campaign_id = c.id) AS streets,
       r.status AS cov_status, r.planned_length_m, r.covered_length_m, r.percent, r.computed_at, r.distance_m, r.sessions_count, r.valid_points, r.methodology_version, r.streets AS street_rows
       FROM campaigns c JOIN stores s ON s.id = c.store_id
       LEFT JOIN LATERAL (SELECT * FROM coverage_results x WHERE x.campaign_id = c.id ORDER BY x.computed_at DESC LIMIT 1) r ON TRUE
      WHERE ${w} ORDER BY s.name, c.created_at DESC LIMIT 2000`, p
  );
  const COV_LABEL: Record<string, string> = { OK: 'Calculada', INCONCLUSIVE: 'Inconclusiva (poucos dados)', NO_DATA: 'Sem dados de GPS', NO_PLAN: 'Sem ruas planejadas' };
  const data = rows.map((r) => {
    const streets = (r.street_rows ?? []) as any[];
    return {
      id: r.id, store: `${r.store_name} (${r.store_code})`, campaign: r.name, status: CAMPAIGN_STATUS_LABEL[r.status],
      startDate: r.start_date, endDate: r.end_date, streets: Number(r.streets),
      streetsDone: streets.filter((s) => s.status === 'DONE').length,
      streetsPartial: streets.filter((s) => s.status === 'PARTIAL').length,
      streetsPending: streets.filter((s) => s.status === 'PENDING').length,
      plannedM: r.planned_length_m === null ? null : Math.round(r.planned_length_m),
      coveredM: r.covered_length_m === null ? null : Math.round(r.covered_length_m),
      percent: r.percent === null ? null : Number(r.percent),
      coverageStatus: r.cov_status ? COV_LABEL[r.cov_status] : 'Ainda não calculada',
      sessions: r.sessions_count, distanceM: r.distance_m === null ? null : Math.round(r.distance_m),
      computedAt: r.computed_at, methodology: r.methodology_version,
    };
  });
  if (req.query.format === 'csv') {
    await exportAudit(req, 'Cobertura por campanha', data.length, f);
    return sendCsv(res, 'rastro-cobertura.csv',
      ['loja', 'campanha', 'situacao', 'inicio', 'termino', 'ruas_planejadas', 'ruas_percorridas', 'ruas_parciais', 'ruas_pendentes', 'metros_planejados', 'metros_percorridos', 'cobertura_estimada_pct', 'calculo', 'sessoes', 'distancia_m', 'calculado_em', 'metodologia'],
      data.map((d) => [d.store, d.campaign, d.status, d.startDate ?? 'A definir', d.endDate ?? 'A definir', d.streets, d.streetsDone, d.streetsPartial, d.streetsPending,
        d.plannedM, d.coveredM, d.percent, d.coverageStatus, d.sessions, d.distanceM, d.computedAt && new Date(d.computedAt).toISOString(), d.methodology]));
  }
  return res.json({ period: periodLabel(f), rows: data });
}));
