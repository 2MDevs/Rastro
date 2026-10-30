import { Router } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db';
import { h, HttpError, parse } from '../http';
import { audit } from '../audit';
import { requireAuth, requireCapability, userOf, newId } from '../auth/core';
import { assertStoreAccess, can, scopeSql, storeLabel, MATRIX_ROLES, SessionUser } from '../access';
import { bboxOf } from '../services/geo';
import { fetchStreetsInArea, STREET_TYPES } from '../services/osm';
import { computeCampaignCoverage, latestCoverage } from '../services/coverage';
import { broadcast } from '../services/realtime';
import { emitWebhook } from '../services/webhooks';

export const campaignsRouter = Router();
campaignsRouter.use(requireAuth({ apiKeyScopes: ['campaigns:read'] }));

export const CAMPAIGN_STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Rascunho', PLANNED: 'Planejada', ACTIVE: 'Ativa', PAUSED: 'Pausada', FINISHED: 'Concluída', CANCELLED: 'Cancelada',
};

const TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['PLANNED', 'ACTIVE', 'CANCELLED'],
  PLANNED: ['DRAFT', 'ACTIVE', 'CANCELLED'],
  ACTIVE: ['PAUSED', 'FINISHED', 'CANCELLED'],
  PAUSED: ['ACTIVE', 'FINISHED', 'CANCELLED'],
  FINISHED: ['ACTIVE'],
  CANCELLED: [],
};

const LIST_SQL = `
  SELECT c.*, s.name AS store_name, s.code AS store_code, a.name AS area_name,
    (SELECT COUNT(*) FROM planned_streets p WHERE p.campaign_id = c.id) AS streets_count,
    (SELECT COALESCE(SUM(p.length_m), 0) FROM planned_streets p WHERE p.campaign_id = c.id) AS planned_length_m,
    (SELECT COUNT(*) FROM tracking_sessions t WHERE t.campaign_id = c.id) AS sessions_count,
    (SELECT COUNT(*) FROM tracking_sessions t WHERE t.campaign_id = c.id AND t.status = 'IN_PROGRESS') AS live_sessions,
    COALESCE((SELECT json_agg(json_build_object('id', u.id, 'name', u.name) ORDER BY u.name)
                FROM campaign_assignments ca JOIN users u ON u.id = ca.user_id WHERE ca.campaign_id = c.id), '[]') AS assignees,
    (SELECT json_build_object('status', r.status, 'percent', r.percent, 'computedAt', r.computed_at)
       FROM coverage_results r WHERE r.campaign_id = c.id ORDER BY r.computed_at DESC LIMIT 1) AS coverage
  FROM campaigns c
  JOIN stores s ON s.id = c.store_id
  LEFT JOIN coverage_areas a ON a.id = c.coverage_area_id`;

export function campaignDto(r: any) {
  return {
    id: r.id, storeId: r.store_id, storeName: r.store_name, storeCode: r.store_code,
    name: r.name, description: r.description, status: r.status, statusLabel: CAMPAIGN_STATUS_LABEL[r.status],
    areaId: r.coverage_area_id, areaName: r.area_name,
    startDate: r.start_date, endDate: r.end_date,
    streetsCount: Number(r.streets_count || 0), plannedLengthM: Math.round(Number(r.planned_length_m || 0)),
    sessionsCount: Number(r.sessions_count || 0), liveSessions: Number(r.live_sessions || 0),
    assignees: r.assignees ?? [], coverage: r.coverage ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** Divulgador só enxerga campanhas para as quais foi designado */
function promoterFilter(user: SessionUser, params: unknown[]) {
  if (user.role !== 'PROMOTER') return 'TRUE';
  params.push(user.id);
  return `EXISTS (SELECT 1 FROM campaign_assignments x WHERE x.campaign_id = c.id AND x.user_id = $${params.length})`;
}

export async function loadCampaign(user: SessionUser, id: string) {
  const { rows } = await pool.query(`${LIST_SQL} WHERE c.id = $1`, [id]);
  const c = rows[0];
  if (!c) throw new HttpError(404, 'Campanha não encontrada.');
  assertStoreAccess(user, c.store_id);
  if (user.role === 'PROMOTER' && !c.assignees.some((a: any) => a.id === user.id)) throw new HttpError(404, 'Campanha não encontrada.');
  return c;
}

async function history(db: any, campaignId: string, user: SessionUser, action: string, details: Record<string, unknown> = {}) {
  await db.query(
    'INSERT INTO campaign_history (campaign_id, user_id, user_name, action, details) VALUES ($1, $2, $3, $4, $5)',
    [campaignId, user.id, user.auditName, action, JSON.stringify(details)]
  );
}

campaignsRouter.get('/', h(async (req, res) => {
  const user = userOf(req);
  const params: unknown[] = [];
  let where = `${scopeSql(user, 'c.store_id', params)} AND ${promoterFilter(user, params)}`;
  if (req.query.storeId) {
    assertStoreAccess(user, String(req.query.storeId));
    params.push(String(req.query.storeId));
    where += ` AND c.store_id = $${params.length}`;
  }
  if (req.query.status) {
    const statuses = String(req.query.status).split(',').filter((s) => s in CAMPAIGN_STATUS_LABEL);
    if (statuses.length) { params.push(statuses); where += ` AND c.status = ANY($${params.length}::text[])`; }
  }
  const { rows } = await pool.query(`${LIST_SQL} WHERE ${where} ORDER BY (c.status = 'ACTIVE') DESC, c.updated_at DESC LIMIT 500`, params);
  return res.json(rows.map(campaignDto));
}));

/** Ruas anunciadas para o mapa: campanhas escolhidas (ou ativas/pausadas das lojas escolhidas), com a situação do último cálculo */
campaignsRouter.get('/map/streets', h(async (req, res) => {
  const user = userOf(req);
  const params: unknown[] = [];
  let where = `${scopeSql(user, 'c.store_id', params)} AND ${promoterFilter(user, params)}`;
  if (req.query.campaignId) {
    params.push(String(req.query.campaignId)); where += ` AND c.id = $${params.length}`;
  } else {
    const ids = String(req.query.storeIds || '').split(',').filter(Boolean).slice(0, 200);
    if (!ids.length) return res.json({ type: 'FeatureCollection', features: [] });
    ids.forEach((id) => assertStoreAccess(user, id));
    params.push(ids); where += ` AND c.store_id = ANY($${params.length}::text[]) AND c.status IN ('ACTIVE','PAUSED','PLANNED')`;
  }
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.highway, p.geometry, p.length_m, c.id AS campaign_id, c.name AS campaign_name, c.store_id,
            (SELECT r.streets FROM coverage_results r WHERE r.campaign_id = c.id ORDER BY r.computed_at DESC LIMIT 1) AS cov
       FROM planned_streets p JOIN campaigns c ON c.id = p.campaign_id WHERE ${where} LIMIT 20000`, params
  );
  const covByCampaign = new Map<string, Map<string, any>>();
  const features = rows.map((r) => {
    let m = covByCampaign.get(r.campaign_id);
    if (!m) { m = new Map((r.cov ?? []).map((x: any) => [x.id, x])); covByCampaign.set(r.campaign_id, m); }
    const c = m.get(r.id);
    return {
      type: 'Feature', geometry: r.geometry,
      properties: { id: r.id, name: r.name ?? 'Rua sem nome', highway: STREET_TYPES[r.highway] ?? r.highway, lengthM: Math.round(r.length_m),
        campaignId: r.campaign_id, campaignName: r.campaign_name, storeId: r.store_id, status: c?.status ?? null, coveredPct: c?.coveredPct ?? null },
    };
  });
  return res.json({ type: 'FeatureCollection', features });
}));

campaignsRouter.get('/:id', h(async (req, res) => {
  const user = userOf(req);
  const c = await loadCampaign(user, req.params.id);
  const area = c.coverage_area_id
    ? (await pool.query('SELECT id, name, kind, geometry, radius_m, center_lat, center_lng FROM coverage_areas WHERE id = $1', [c.coverage_area_id])).rows[0]
    : null;
  return res.json({
    ...campaignDto(c),
    area: area ? { id: area.id, name: area.name, kind: area.kind, geometry: area.geometry, radiusM: area.radius_m } : null,
    transitions: can(user.role, 'campaigns.manage') ? TRANSITIONS[c.status] : [],
  });
}));

campaignsRouter.get('/:id/history', h(async (req, res) => {
  const user = userOf(req);
  await loadCampaign(user, req.params.id);
  const { rows } = await pool.query(
    'SELECT user_name, action, details, occurred_at FROM campaign_history WHERE campaign_id = $1 ORDER BY occurred_at DESC LIMIT 200',
    [req.params.id]
  );
  return res.json(rows.map((r) => ({ userName: r.user_name, action: r.action, details: r.details, at: r.occurred_at })));
}));

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.');
const CampaignInput = z.object({
  storeId: z.string(),
  name: z.string().trim().min(2, 'Dê um nome à campanha.').max(120),
  description: z.string().trim().max(2000).optional().nullable(),
  areaId: z.string().optional().nullable(),
  startDate: dateStr.optional().nullable(),
  endDate: dateStr.optional().nullable(),
  assigneeIds: z.array(z.string()).max(100).optional(),
});

async function checkArea(storeId: string, areaId: string | null | undefined) {
  if (!areaId) return;
  const { rows } = await pool.query('SELECT store_id, archived_at FROM coverage_areas WHERE id = $1', [areaId]);
  if (!rows[0] || rows[0].store_id !== storeId) throw new HttpError(400, 'O território escolhido não pertence a esta loja.');
  if (rows[0].archived_at) throw new HttpError(400, 'O território escolhido está arquivado.');
}

async function checkAssignees(storeId: string, ids: string[]) {
  if (!ids.length) return;
  const { rows } = await pool.query(
    `SELECT u.id FROM users u WHERE u.id = ANY($1::text[]) AND u.status = 'ACTIVE'
       AND (u.role = ANY($3::text[]) OR EXISTS (SELECT 1 FROM user_store_access a WHERE a.user_id = u.id AND a.store_id = $2))`,
    [ids, storeId, MATRIX_ROLES]
  );
  if (rows.length !== new Set(ids).size) throw new HttpError(400, 'Um dos responsáveis não tem acesso a esta loja ou está bloqueado.');
}

campaignsRouter.post('/', requireCapability('campaigns.manage'), h(async (req, res) => {
  const user = userOf(req);
  const body = parse(CampaignInput, req.body);
  assertStoreAccess(user, body.storeId);
  if (body.startDate && body.endDate && body.endDate < body.startDate) throw new HttpError(400, 'A data de término não pode ser antes do início.');
  await checkArea(body.storeId, body.areaId);
  await checkAssignees(body.storeId, body.assigneeIds ?? []);
  const id = newId('cmp');
  await tx(async (db) => {
    await db.query(
      `INSERT INTO campaigns (id, store_id, name, description, coverage_area_id, start_date, end_date, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, body.storeId, body.name, body.description || null, body.areaId || null, body.startDate || null, body.endDate || null, user.id]
    );
    for (const uid of new Set(body.assigneeIds ?? [])) {
      await db.query('INSERT INTO campaign_assignments (campaign_id, user_id, assigned_by) VALUES ($1,$2,$3)', [id, uid, user.id]);
    }
    await history(db, id, user, 'Campanha criada', { situacao: 'Rascunho' });
    await audit(req, { action: 'CAMPAIGN_CREATED', targetType: 'campaign', targetId: id, targetName: body.name, scope: await storeLabel(body.storeId, db) }, db);
  });
  broadcast('data', { kind: 'campaigns', storeId: body.storeId }, body.storeId);
  return res.status(201).json(campaignDto((await pool.query(`${LIST_SQL} WHERE c.id = $1`, [id])).rows[0]));
}));

campaignsRouter.patch('/:id', requireCapability('campaigns.manage'), h(async (req, res) => {
  const user = userOf(req);
  const c = await loadCampaign(user, req.params.id);
  if (['FINISHED', 'CANCELLED'].includes(c.status)) throw new HttpError(400, 'Campanhas concluídas ou canceladas não podem ser alteradas.');
  const body = parse(CampaignInput.omit({ storeId: true }).partial(), req.body);
  const start = body.startDate !== undefined ? body.startDate : c.start_date;
  const end = body.endDate !== undefined ? body.endDate : c.end_date;
  if (start && end && end < start) throw new HttpError(400, 'A data de término não pode ser antes do início.');
  if (body.areaId !== undefined) await checkArea(c.store_id, body.areaId);
  if (body.assigneeIds) await checkAssignees(c.store_id, body.assigneeIds);
  const changes: Record<string, unknown> = {};
  if (body.name !== undefined && body.name !== c.name) changes.nome = body.name;
  if (body.description !== undefined && body.description !== c.description) changes.descricao = 'alterada';
  if (body.areaId !== undefined && body.areaId !== c.coverage_area_id) changes.territorio = body.areaId ? 'alterado' : 'removido';
  if (body.startDate !== undefined && body.startDate !== c.start_date) changes.inicio = body.startDate ?? 'A definir';
  if (body.endDate !== undefined && body.endDate !== c.end_date) changes.termino = body.endDate ?? 'A definir';
  await tx(async (db) => {
    await db.query(
      `UPDATE campaigns SET name = COALESCE($2, name),
         description = CASE WHEN $3::boolean THEN $4 ELSE description END,
         coverage_area_id = CASE WHEN $5::boolean THEN $6 ELSE coverage_area_id END,
         start_date = CASE WHEN $7::boolean THEN $8::date ELSE start_date END,
         end_date = CASE WHEN $9::boolean THEN $10::date ELSE end_date END,
         updated_at = NOW() WHERE id = $1`,
      [c.id, body.name ?? null, body.description !== undefined, body.description || null, body.areaId !== undefined, body.areaId || null,
        body.startDate !== undefined, body.startDate || null, body.endDate !== undefined, body.endDate || null]
    );
    if (body.assigneeIds) {
      const before = new Set<string>(c.assignees.map((a: any) => a.id));
      const after = new Set(body.assigneeIds);
      await db.query('DELETE FROM campaign_assignments WHERE campaign_id = $1 AND NOT (user_id = ANY($2::text[]))', [c.id, [...after]]);
      for (const uid of after) {
        if (!before.has(uid)) await db.query('INSERT INTO campaign_assignments (campaign_id, user_id, assigned_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [c.id, uid, user.id]);
      }
      const added = [...after].filter((x) => !before.has(x)).length, removed = [...before].filter((x) => !after.has(x)).length;
      if (added || removed) {
        changes.responsaveis = `${added} incluído(s), ${removed} removido(s)`;
        await audit(req, { action: 'CAMPAIGN_ASSIGNMENTS', targetType: 'campaign', targetId: c.id, targetName: c.name, scope: `${c.store_name} (${c.store_code})`, details: String(changes.responsaveis) }, db);
      }
    }
    if (Object.keys(changes).length) {
      await history(db, c.id, user, 'Campanha alterada', changes);
      await audit(req, { action: 'CAMPAIGN_UPDATED', targetType: 'campaign', targetId: c.id, targetName: c.name, scope: `${c.store_name} (${c.store_code})`, details: `Alterado: ${Object.keys(changes).join(', ')}.` }, db);
    }
  });
  broadcast('data', { kind: 'campaigns', storeId: c.store_id, campaignId: c.id }, c.store_id);
  return res.json(campaignDto((await pool.query(`${LIST_SQL} WHERE c.id = $1`, [c.id])).rows[0]));
}));

campaignsRouter.post('/:id/status', requireCapability('campaigns.manage'), h(async (req, res) => {
  const user = userOf(req);
  const c = await loadCampaign(user, req.params.id);
  const { status, note } = parse(z.object({ status: z.enum(['DRAFT', 'PLANNED', 'ACTIVE', 'PAUSED', 'FINISHED', 'CANCELLED']), note: z.string().max(500).optional() }), req.body);
  if (!TRANSITIONS[c.status].includes(status)) {
    throw new HttpError(400, `Não é possível passar de "${CAMPAIGN_STATUS_LABEL[c.status]}" para "${CAMPAIGN_STATUS_LABEL[status]}".`);
  }
  await tx(async (db) => {
    const r = await db.query('UPDATE campaigns SET status = $2, updated_at = NOW() WHERE id = $1 AND status = $3', [c.id, status, c.status]);
    if (!r.rowCount) throw new HttpError(409, 'A campanha foi alterada por outra pessoa. Atualize a tela.');
    await history(db, c.id, user, 'Situação alterada', { de: CAMPAIGN_STATUS_LABEL[c.status], para: CAMPAIGN_STATUS_LABEL[status], ...(note ? { observacao: note } : {}) });
    await audit(req, { action: 'CAMPAIGN_STATUS', targetType: 'campaign', targetId: c.id, targetName: c.name, scope: `${c.store_name} (${c.store_code})`,
      details: `${CAMPAIGN_STATUS_LABEL[c.status]} → ${CAMPAIGN_STATUS_LABEL[status]}${note ? `. Obs.: ${note}` : ''}` }, db);
  });
  emitWebhook('campaign.status_changed', { campaignId: c.id, storeId: c.store_id, from: c.status, to: status });
  broadcast('data', { kind: 'campaigns', storeId: c.store_id, campaignId: c.id }, c.store_id);
  return res.json(campaignDto((await pool.query(`${LIST_SQL} WHERE c.id = $1`, [c.id])).rows[0]));
}));

// ---------------------------------------------------------------- ruas: candidatas (rede viária) e planejadas
campaignsRouter.post('/:id/streets/fetch', requireCapability('campaigns.manage'), h(async (req, res) => {
  const user = userOf(req);
  const c = await loadCampaign(user, req.params.id);
  if (!c.coverage_area_id) throw new HttpError(400, 'Escolha um território para a campanha antes de buscar as ruas.');
  const { rows } = await pool.query('SELECT geometry FROM coverage_areas WHERE id = $1', [c.coverage_area_id]);
  const pieces = await fetchStreetsInArea(rows[0].geometry, req.body?.includeService === true);
  await tx(async (db) => {
    await db.query('DELETE FROM street_candidates WHERE campaign_id = $1', [c.id]);
    for (const p of pieces) {
      await db.query(
        `INSERT INTO street_candidates (campaign_id, osm_way_id, piece, name, highway, geometry, length_m) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT DO NOTHING`,
        [c.id, p.osmWayId, p.piece, p.name, p.highway, JSON.stringify({ type: 'LineString', coordinates: p.coordinates }), p.lengthM]
      );
    }
    await audit(req, { action: 'STREETS_FETCHED', targetType: 'campaign', targetId: c.id, targetName: c.name, scope: `${c.store_name} (${c.store_code})`,
      details: `${pieces.length} trecho(s) de rua encontrados no território (OpenStreetMap).` }, db);
  });
  return res.json({ found: pieces.length });
}));

function streetKey(osmWayId: number | string, piece: number) {
  return `${osmWayId}:${piece}`;
}

campaignsRouter.get('/:id/streets', h(async (req, res) => {
  const user = userOf(req);
  const c = await loadCampaign(user, req.params.id);
  const [planned, candidates, cov] = await Promise.all([
    pool.query('SELECT id, osm_way_id, piece, name, highway, geometry, length_m FROM planned_streets WHERE campaign_id = $1 ORDER BY name NULLS LAST, osm_way_id, piece', [c.id]),
    req.query.candidates === 'true'
      ? pool.query('SELECT osm_way_id, piece, name, highway, geometry, length_m, fetched_at FROM street_candidates WHERE campaign_id = $1 ORDER BY name NULLS LAST', [c.id])
      : Promise.resolve({ rows: [] as any[] }),
    latestCoverage(c.id),
  ]);
  const status = new Map<string, any>((cov?.streets ?? []).map((s: any) => [s.id, s]));
  const plannedKeys = new Set(planned.rows.map((p) => streetKey(p.osm_way_id, p.piece)));
  return res.json({
    planned: planned.rows.map((p) => ({
      id: p.id, key: p.osm_way_id ? streetKey(p.osm_way_id, p.piece) : p.id, osmWayId: p.osm_way_id, name: p.name, highway: p.highway,
      highwayLabel: STREET_TYPES[p.highway] ?? p.highway, geometry: p.geometry, lengthM: Math.round(p.length_m),
      coverage: status.get(p.id) ? { status: (status.get(p.id) as any).status, coveredPct: (status.get(p.id) as any).coveredPct } : null,
    })),
    candidates: candidates.rows.map((p) => ({
      key: streetKey(p.osm_way_id, p.piece), osmWayId: p.osm_way_id, name: p.name, highway: p.highway, highwayLabel: STREET_TYPES[p.highway] ?? p.highway,
      geometry: p.geometry, lengthM: Math.round(p.length_m), planned: plannedKeys.has(streetKey(p.osm_way_id, p.piece)), fetchedAt: p.fetched_at,
    })),
  });
}));

campaignsRouter.put('/:id/streets', requireCapability('campaigns.manage'), h(async (req, res) => {
  const user = userOf(req);
  const c = await loadCampaign(user, req.params.id);
  if (['FINISHED', 'CANCELLED'].includes(c.status)) throw new HttpError(400, 'Campanhas concluídas ou canceladas não podem ter as ruas alteradas.');
  const { keys } = parse(z.object({ keys: z.array(z.string().regex(/^\d+:\d+$/)).max(5000) }), req.body);
  const wanted = new Set(keys);
  const { rows: cands } = await pool.query('SELECT * FROM street_candidates WHERE campaign_id = $1', [c.id]);
  const byKey = new Map<string, any>(cands.map((r: any) => [streetKey(r.osm_way_id, r.piece), r]));
  const { rows: current } = await pool.query('SELECT id, osm_way_id, piece FROM planned_streets WHERE campaign_id = $1', [c.id]);
  const currentKeys = new Set(current.map((r) => streetKey(r.osm_way_id, r.piece)));
  const toAdd = [...wanted].filter((k) => !currentKeys.has(k));
  const missing = toAdd.filter((k) => !byKey.has(k));
  if (missing.length) throw new HttpError(400, 'Algumas ruas não estão mais na lista encontrada. Busque as ruas de novo.');
  const toRemove = current.filter((r) => !wanted.has(streetKey(r.osm_way_id, r.piece)));
  await tx(async (db) => {
    if (toRemove.length) await db.query('DELETE FROM planned_streets WHERE id = ANY($1::text[])', [toRemove.map((r) => r.id)]);
    for (const k of toAdd) {
      const s = byKey.get(k)!;
      const bb = bboxOf(s.geometry.coordinates);
      await db.query(
        `INSERT INTO planned_streets (id, campaign_id, store_id, osm_way_id, piece, name, highway, geometry, length_m, min_lat, min_lng, max_lat, max_lng, added_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [newId('rua'), c.id, c.store_id, s.osm_way_id, s.piece, s.name, s.highway, JSON.stringify(s.geometry), s.length_m, bb.minLat, bb.minLng, bb.maxLat, bb.maxLng, user.id]
      );
    }
    if (toAdd.length || toRemove.length) {
      await history(db, c.id, user, 'Ruas planejadas alteradas', { incluidas: toAdd.length, removidas: toRemove.length, total: wanted.size });
      await audit(req, { action: 'STREETS_PLANNED', targetType: 'campaign', targetId: c.id, targetName: c.name, scope: `${c.store_name} (${c.store_code})`,
        details: `${toAdd.length} incluída(s), ${toRemove.length} removida(s). Total planejado: ${wanted.size}.` }, db);
    }
  });
  broadcast('data', { kind: 'streets', storeId: c.store_id, campaignId: c.id }, c.store_id);
  return res.json({ planned: wanted.size, added: toAdd.length, removed: toRemove.length });
}));

// ---------------------------------------------------------------- cobertura estimada
campaignsRouter.get('/:id/coverage', h(async (req, res) => {
  const user = userOf(req);
  const c = await loadCampaign(user, req.params.id);
  return res.json(await latestCoverage(c.id));
}));

campaignsRouter.post('/:id/coverage', requireCapability('campaigns.manage'), h(async (req, res) => {
  const user = userOf(req);
  const c = await loadCampaign(user, req.params.id);
  const result = await computeCampaignCoverage(c.id, user.auditName);
  await audit(req, { action: 'COVERAGE_COMPUTED', targetType: 'campaign', targetId: c.id, targetName: c.name, scope: `${c.store_name} (${c.store_code})`,
    details: result?.percent !== null && result?.percent !== undefined ? `Cobertura estimada: ${result.percent}%.` : `Resultado: ${result?.status}.` });
  emitWebhook('coverage.computed', { campaignId: c.id, storeId: c.store_id, status: result?.status, percent: result?.percent });
  broadcast('data', { kind: 'coverage', storeId: c.store_id, campaignId: c.id }, c.store_id);
  return res.json(result);
}));
