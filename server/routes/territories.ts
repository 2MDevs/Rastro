import { Router } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db';
import { h, HttpError, parse } from '../http';
import { audit } from '../audit';
import { requireAuth, requireCapability, userOf, newId } from '../auth/core';
import { assertStoreAccess, scopeSql, storeLabel } from '../access';
import { circlePolygon, normalizePolygon, polygonArea, bboxOf, PolygonGeom } from '../services/geo';
import { broadcast } from '../services/realtime';

export const territoriesRouter = Router();
territoriesRouter.use(requireAuth({ apiKeyScopes: ['stores:read'] }));

function areaDto(r: any) {
  return {
    id: r.id, storeId: r.store_id, name: r.name, kind: r.kind,
    center: r.center_lat === null ? null : { lat: r.center_lat, lng: r.center_lng },
    radiusM: r.radius_m, geometry: r.geometry, areaM2: Math.round(r.area_m2),
    archived: Boolean(r.archived_at), createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

territoriesRouter.get('/areas', h(async (req, res) => {
  const user = userOf(req);
  const params: unknown[] = [];
  let where = scopeSql(user, 'a.store_id', params);
  if (req.query.storeId) {
    assertStoreAccess(user, String(req.query.storeId));
    params.push(String(req.query.storeId));
    where += ` AND a.store_id = $${params.length}`;
  }
  if (req.query.includeArchived !== 'true') where += ' AND a.archived_at IS NULL';
  const { rows } = await pool.query(`SELECT a.* FROM coverage_areas a WHERE ${where} ORDER BY a.created_at`, params);
  return res.json(rows.map(areaDto));
}));

const AreaInput = z.object({
  storeId: z.string(),
  name: z.string().trim().min(2, 'Dê um nome ao território.').max(120),
  kind: z.enum(['RADIUS', 'POLYGON']),
  center: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
  radiusM: z.number().min(50, 'O raio mínimo é de 50 metros.').max(30_000, 'O raio máximo é de 30 km.').optional(),
  geometry: z.unknown().optional(),
});

async function buildGeometry(kind: 'RADIUS' | 'POLYGON', storeId: string, input: { center?: { lat: number; lng: number }; radiusM?: number; geometry?: unknown }) {
  if (kind === 'RADIUS') {
    let center = input.center;
    if (!center) {
      const { rows } = await pool.query('SELECT lat, lng FROM stores WHERE id = $1', [storeId]);
      if (rows[0]?.lat === null || !rows[0]) throw new HttpError(400, 'Defina a localização da loja antes de criar um raio a partir dela.');
      center = { lat: rows[0].lat, lng: rows[0].lng };
    }
    if (!input.radiusM) throw new HttpError(400, 'Informe o raio em metros.');
    const geometry = circlePolygon([center.lng, center.lat], input.radiusM);
    return { geometry, center, radiusM: input.radiusM };
  }
  let geometry: PolygonGeom;
  try {
    geometry = normalizePolygon(input.geometry);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  return { geometry, center: null, radiusM: null };
}

territoriesRouter.post('/areas', requireCapability('territory.manage'), h(async (req, res) => {
  const user = userOf(req);
  const body = parse(AreaInput, req.body);
  assertStoreAccess(user, body.storeId);
  const g = await buildGeometry(body.kind, body.storeId, body);
  const bb = bboxOf(g.geometry.coordinates[0]);
  const id = newId('ter');
  const scope = await storeLabel(body.storeId);
  await tx(async (db) => {
    await db.query(
      `INSERT INTO coverage_areas (id, store_id, name, kind, center_lat, center_lng, radius_m, geometry, area_m2, min_lat, min_lng, max_lat, max_lng, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, body.storeId, body.name, body.kind, g.center?.lat ?? null, g.center?.lng ?? null, g.radiusM, JSON.stringify(g.geometry),
        polygonArea(g.geometry), bb.minLat, bb.minLng, bb.maxLat, bb.maxLng, user.id]
    );
    await audit(req, { action: 'AREA_CREATED', targetType: 'area', targetId: id, targetName: body.name, scope,
      details: body.kind === 'RADIUS' ? `Raio de ${Math.round(g.radiusM!)} m.` : `Perímetro desenhado com ${g.geometry.coordinates[0].length - 1} pontos.` }, db);
  });
  const { rows } = await pool.query('SELECT * FROM coverage_areas WHERE id = $1', [id]);
  broadcast('data', { kind: 'areas', storeId: body.storeId }, body.storeId);
  return res.status(201).json(areaDto(rows[0]));
}));

territoriesRouter.patch('/areas/:id', requireCapability('territory.manage'), h(async (req, res) => {
  const user = userOf(req);
  const { rows: cur } = await pool.query('SELECT * FROM coverage_areas WHERE id = $1', [req.params.id]);
  const a = cur[0];
  if (!a) throw new HttpError(404, 'Território não encontrado.');
  assertStoreAccess(user, a.store_id);
  if (a.archived_at) throw new HttpError(400, 'Este território está arquivado.');
  const body = parse(AreaInput.omit({ storeId: true, kind: true }).partial(), req.body);
  const geomChanged = body.center !== undefined || body.radiusM !== undefined || body.geometry !== undefined;
  let g = { geometry: a.geometry as PolygonGeom, center: a.center_lat === null ? null : { lat: a.center_lat, lng: a.center_lng }, radiusM: a.radius_m };
  if (geomChanged) {
    g = await buildGeometry(a.kind, a.store_id, {
      center: body.center ?? (a.center_lat === null ? undefined : { lat: a.center_lat, lng: a.center_lng }),
      radiusM: body.radiusM ?? a.radius_m ?? undefined,
      geometry: body.geometry ?? a.geometry,
    });
  }
  const bb = bboxOf(g.geometry.coordinates[0]);
  await tx(async (db) => {
    await db.query(
      `UPDATE coverage_areas SET name = COALESCE($2, name), center_lat = $3, center_lng = $4, radius_m = $5, geometry = $6, area_m2 = $7,
         min_lat = $8, min_lng = $9, max_lat = $10, max_lng = $11, updated_at = NOW() WHERE id = $1`,
      [a.id, body.name ?? null, g.center?.lat ?? null, g.center?.lng ?? null, g.radiusM, JSON.stringify(g.geometry), polygonArea(g.geometry),
        bb.minLat, bb.minLng, bb.maxLat, bb.maxLng]
    );
    await audit(req, { action: 'AREA_UPDATED', targetType: 'area', targetId: a.id, targetName: body.name ?? a.name, scope: await storeLabel(a.store_id, db),
      details: geomChanged ? (a.kind === 'RADIUS' ? `Alcance ajustado para ${Math.round(g.radiusM!)} m.` : 'Perímetro redesenhado.') : 'Nome alterado.' }, db);
  });
  const { rows } = await pool.query('SELECT * FROM coverage_areas WHERE id = $1', [a.id]);
  broadcast('data', { kind: 'areas', storeId: a.store_id }, a.store_id);
  return res.json(areaDto(rows[0]));
}));

territoriesRouter.post('/areas/:id/archive', requireCapability('territory.manage'), h(async (req, res) => {
  const user = userOf(req);
  const { rows } = await pool.query('SELECT * FROM coverage_areas WHERE id = $1', [req.params.id]);
  const a = rows[0];
  if (!a) throw new HttpError(404, 'Território não encontrado.');
  assertStoreAccess(user, a.store_id);
  await tx(async (db) => {
    await db.query('UPDATE coverage_areas SET archived_at = NOW(), updated_at = NOW() WHERE id = $1', [a.id]);
    await audit(req, { action: 'AREA_ARCHIVED', targetType: 'area', targetId: a.id, targetName: a.name, scope: await storeLabel(a.store_id, db),
      details: 'Território arquivado (o histórico das campanhas é preservado).' }, db);
  });
  broadcast('data', { kind: 'areas', storeId: a.store_id }, a.store_id);
  return res.json({ ok: true });
}));

// ---------------------------------------------------------------- pontos de interesse
const PoiInput = z.object({
  storeId: z.string(),
  name: z.string().trim().min(2, 'Informe o nome do ponto.').max(120),
  category: z.string().trim().min(1).max(60).default('Outro'),
  notes: z.string().trim().max(500).optional().nullable(),
  location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
});

const poiDto = (r: any) => ({ id: r.id, storeId: r.store_id, name: r.name, category: r.category, notes: r.notes, location: { lat: r.lat, lng: r.lng }, updatedAt: r.updated_at });

territoriesRouter.get('/pois', h(async (req, res) => {
  const user = userOf(req);
  const params: unknown[] = [];
  let where = scopeSql(user, 'store_id', params);
  if (req.query.storeId) {
    assertStoreAccess(user, String(req.query.storeId));
    params.push(String(req.query.storeId));
    where += ` AND store_id = $${params.length}`;
  }
  const { rows } = await pool.query(`SELECT * FROM points_of_interest WHERE ${where} ORDER BY name`, params);
  return res.json(rows.map(poiDto));
}));

territoriesRouter.post('/pois', requireCapability('territory.manage'), h(async (req, res) => {
  const user = userOf(req);
  const body = parse(PoiInput, req.body);
  assertStoreAccess(user, body.storeId);
  const id = newId('poi');
  await tx(async (db) => {
    await db.query(
      `INSERT INTO points_of_interest (id, store_id, name, category, notes, lat, lng, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, body.storeId, body.name, body.category, body.notes || null, body.location.lat, body.location.lng, user.id]
    );
    await audit(req, { action: 'POI_CREATED', targetType: 'poi', targetId: id, targetName: body.name, scope: await storeLabel(body.storeId, db), details: `Categoria: ${body.category}.` }, db);
  });
  const { rows } = await pool.query('SELECT * FROM points_of_interest WHERE id = $1', [id]);
  broadcast('data', { kind: 'pois', storeId: body.storeId }, body.storeId);
  return res.status(201).json(poiDto(rows[0]));
}));

territoriesRouter.patch('/pois/:id', requireCapability('territory.manage'), h(async (req, res) => {
  const user = userOf(req);
  const { rows: cur } = await pool.query('SELECT * FROM points_of_interest WHERE id = $1', [req.params.id]);
  const p = cur[0];
  if (!p) throw new HttpError(404, 'Ponto não encontrado.');
  assertStoreAccess(user, p.store_id);
  const body = parse(PoiInput.omit({ storeId: true }).partial(), req.body);
  await tx(async (db) => {
    await db.query(
      `UPDATE points_of_interest SET name = COALESCE($2, name), category = COALESCE($3, category),
         notes = CASE WHEN $4::boolean THEN $5 ELSE notes END, lat = COALESCE($6, lat), lng = COALESCE($7, lng), updated_at = NOW() WHERE id = $1`,
      [p.id, body.name ?? null, body.category ?? null, body.notes !== undefined, body.notes || null, body.location?.lat ?? null, body.location?.lng ?? null]
    );
    await audit(req, { action: 'POI_UPDATED', targetType: 'poi', targetId: p.id, targetName: body.name ?? p.name, scope: await storeLabel(p.store_id, db) }, db);
  });
  const { rows } = await pool.query('SELECT * FROM points_of_interest WHERE id = $1', [p.id]);
  broadcast('data', { kind: 'pois', storeId: p.store_id }, p.store_id);
  return res.json(poiDto(rows[0]));
}));

territoriesRouter.delete('/pois/:id', requireCapability('territory.manage'), h(async (req, res) => {
  const user = userOf(req);
  const { rows } = await pool.query('SELECT * FROM points_of_interest WHERE id = $1', [req.params.id]);
  const p = rows[0];
  if (!p) throw new HttpError(404, 'Ponto não encontrado.');
  assertStoreAccess(user, p.store_id);
  await tx(async (db) => {
    await db.query('DELETE FROM points_of_interest WHERE id = $1', [p.id]);
    await audit(req, { action: 'POI_DELETED', targetType: 'poi', targetId: p.id, targetName: p.name, scope: await storeLabel(p.store_id, db) }, db);
  });
  broadcast('data', { kind: 'pois', storeId: p.store_id }, p.store_id);
  return res.json({ ok: true });
}));
