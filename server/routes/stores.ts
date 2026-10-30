import { Router } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db';
import { h, HttpError, parse } from '../http';
import { audit } from '../audit';
import { requireAuth, requireCapability, userOf, newId } from '../auth/core';
import { assertStoreAccess, scopeSql, MATRIX_ROLES, ROLE_LABEL, Role, isDeveloperEmail } from '../access';
import { broadcast } from '../services/realtime';

export const storesRouter = Router();
storesRouter.use(requireAuth({ apiKeyScopes: ['stores:read'] }));

const STORE_SQL = `
  SELECT s.*,
    (SELECT COUNT(*) FROM campaigns c WHERE c.store_id = s.id AND c.status = 'ACTIVE') AS active_campaigns,
    (SELECT COUNT(*) FROM tracking_sessions t WHERE t.store_id = s.id AND t.status = 'IN_PROGRESS') AS live_sessions,
    (SELECT COUNT(*) FROM coverage_areas a WHERE a.store_id = s.id AND a.archived_at IS NULL) AS areas,
    (SELECT MAX(t.last_point_received_at) FROM tracking_sessions t WHERE t.store_id = s.id) AS last_activity_at
  FROM stores s`;

export function storeDto(r: any) {
  return {
    id: r.id, code: r.code, name: r.name, address: r.address,
    location: r.lat === null ? null : { lat: r.lat, lng: r.lng },
    status: r.status,
    activeCampaigns: Number(r.active_campaigns ?? 0),
    liveSessions: Number(r.live_sessions ?? 0),
    areas: Number(r.areas ?? 0),
    lastActivityAt: r.last_activity_at ?? null,
    // "Em operação" = tem campanha ativa (loja cadastrada não significa loja em operação)
    operating: Number(r.active_campaigns ?? 0) > 0,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

storesRouter.get('/', h(async (req, res) => {
  const user = userOf(req);
  const params: unknown[] = [];
  const { rows } = await pool.query(`${STORE_SQL} WHERE ${scopeSql(user, 's.id', params)} ORDER BY s.name`, params);
  return res.json(rows.map(storeDto));
}));

storesRouter.get('/:id', h(async (req, res) => {
  const user = userOf(req);
  assertStoreAccess(user, req.params.id);
  const { rows } = await pool.query(`${STORE_SQL} WHERE s.id = $1`, [req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Loja não encontrada.');
  return res.json(storeDto(rows[0]));
}));

const StoreInput = z.object({
  code: z.string().trim().min(1, 'Informe o código da loja.').max(30),
  name: z.string().trim().min(2, 'Informe o nome da loja.').max(120),
  address: z.string().trim().max(300).optional().nullable(),
  location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

storesRouter.post('/', requireCapability('stores.manage'), h(async (req, res) => {
  const body = parse(StoreInput, req.body);
  const id = newId('loja');
  try {
    await tx(async (db) => {
      await db.query(
        `INSERT INTO stores (id, code, name, address, lat, lng, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, body.code, body.name, body.address || null, body.location?.lat ?? null, body.location?.lng ?? null, body.status ?? 'ACTIVE', userOf(req).id]
      );
      await audit(req, { action: 'STORE_CREATED', targetType: 'store', targetId: id, targetName: `${body.name} (${body.code})`, scope: `${body.name} (${body.code})`,
        details: body.location ? 'Loja cadastrada com localização.' : 'Loja cadastrada sem localização (A definir).' }, db);
    });
  } catch (err: any) {
    if (err?.code === '23505') throw new HttpError(409, 'Já existe uma loja com este código.');
    throw err;
  }
  const { rows } = await pool.query(`${STORE_SQL} WHERE s.id = $1`, [id]);
  broadcast('data', { kind: 'stores' });
  return res.status(201).json(storeDto(rows[0]));
}));

storesRouter.patch('/:id', requireCapability('stores.manage'), h(async (req, res) => {
  const body = parse(StoreInput.partial(), req.body);
  const { rows: cur } = await pool.query('SELECT * FROM stores WHERE id = $1', [req.params.id]);
  const s = cur[0];
  if (!s) throw new HttpError(404, 'Loja não encontrada.');
  const changes: string[] = [];
  if (body.code !== undefined && body.code !== s.code) changes.push(`código ${s.code} → ${body.code}`);
  if (body.name !== undefined && body.name !== s.name) changes.push('nome');
  if (body.address !== undefined && body.address !== s.address) changes.push('endereço');
  if (body.location !== undefined) changes.push(body.location ? 'localização' : 'localização removida');
  if (body.status !== undefined && body.status !== s.status) changes.push(body.status === 'ACTIVE' ? 'reativada' : 'desativada');
  try {
    await tx(async (db) => {
      await db.query(
        `UPDATE stores SET code = COALESCE($2, code), name = COALESCE($3, name),
           address = CASE WHEN $4::boolean THEN $5 ELSE address END,
           lat = CASE WHEN $6::boolean THEN $7::double precision ELSE lat END,
           lng = CASE WHEN $6::boolean THEN $8::double precision ELSE lng END,
           status = COALESCE($9, status), updated_at = NOW() WHERE id = $1`,
        [s.id, body.code ?? null, body.name ?? null, body.address !== undefined, body.address || null,
          body.location !== undefined, body.location?.lat ?? null, body.location?.lng ?? null, body.status ?? null]
      );
      await audit(req, { action: 'STORE_UPDATED', targetType: 'store', targetId: s.id, targetName: `${s.name} (${s.code})`, scope: `${s.name} (${s.code})`,
        details: `Alterado: ${changes.join(', ') || 'nada'}.` }, db);
    });
  } catch (err: any) {
    if (err?.code === '23505') throw new HttpError(409, 'Já existe uma loja com este código.');
    throw err;
  }
  const { rows } = await pool.query(`${STORE_SQL} WHERE s.id = $1`, [s.id]);
  broadcast('data', { kind: 'stores', storeId: s.id }, s.id);
  return res.json(storeDto(rows[0]));
}));

/** Pessoas que podem ser responsáveis por campanhas desta loja */
storesRouter.get('/:id/people', h(async (req, res) => {
  const user = userOf(req);
  assertStoreAccess(user, req.params.id);
  if (user.apiKey) throw new HttpError(403, 'Esta informação não está disponível por chave de API.');
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, u.role FROM users u
      WHERE u.status = 'ACTIVE' AND (u.role = ANY($2::text[]) OR EXISTS (SELECT 1 FROM user_store_access a WHERE a.user_id = u.id AND a.store_id = $1))
      ORDER BY (u.role = 'PROMOTER') DESC, u.name`,
    [req.params.id, MATRIX_ROLES]
  );
  return res.json(rows.map((r) => {
    const role: Role = isDeveloperEmail(r.email) ? 'DEVELOPER' : r.role;
    return { id: r.id, name: r.name, role, roleLabel: ROLE_LABEL[role] };
  }));
}));
