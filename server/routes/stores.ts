import { Router } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db';
import { h, HttpError, parse } from '../http';
import { audit } from '../audit';
import { requireAuth, requireCapability, userOf, newId } from '../auth/core';
import { assertStoreAccess, assignableRoles, scopeSql, storeLabel, MATRIX_ROLES, ROLE_LABEL, Role, isDeveloperEmail } from '../access';
import { dropUserStreams } from '../services/realtime';
import { broadcast } from '../services/realtime';

export const storesRouter = Router();
storesRouter.use(requireAuth({ apiKeyScopes: ['stores:read'] }));

const STORE_SQL = `
  SELECT s.*,
    (SELECT COUNT(*) FROM campaigns c WHERE c.store_id = s.id AND c.status = 'ACTIVE') AS active_campaigns,
    (SELECT COUNT(*) FROM tracking_sessions t WHERE t.store_id = s.id AND t.status = 'IN_PROGRESS') AS live_sessions,
    (SELECT COUNT(*) FROM coverage_areas a WHERE a.store_id = s.id AND a.archived_at IS NULL) AS areas,
    (SELECT MAX(t.last_point_received_at) FROM tracking_sessions t WHERE t.store_id = s.id) AS last_activity_at,
    (SELECT u.name FROM users u WHERE u.id = s.location_set_by) AS location_set_by_name
  FROM stores s`;

export function storeDto(r: any) {
  return {
    id: r.id, code: r.code, name: r.name, address: r.address,
    location: r.lat === null ? null : { lat: r.lat, lng: r.lng },
    locationInfo: r.lat === null ? null : {
      source: r.location_source ?? null, // GPS = registrada dentro da loja; MAP = marcada no mapa
      accuracyM: r.location_accuracy_m === null || r.location_accuracy_m === undefined ? null : Math.round(r.location_accuracy_m),
      setAt: r.location_set_at ?? null, setByName: r.location_set_by_name ?? null,
    },
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
  code: z.string().trim().max(30).optional().nullable(),
  name: z.string().trim().min(2, 'Informe o nome da loja.').max(120),
  address: z.string().trim().max(300).optional().nullable(),
  location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

storesRouter.post('/', requireCapability('stores.manage'), h(async (req, res) => {
  const body = parse(StoreInput, req.body);
  if (!body.code) {
    // Sem código informado: gera o próximo número livre (001, 002, ...)
    const { rows } = await pool.query(`SELECT code FROM stores WHERE code ~ '^[0-9]+$'`);
    const used = new Set(rows.map((r) => Number(r.code)));
    let n = 1;
    while (used.has(n)) n++;
    body.code = String(n).padStart(3, '0');
  }
  const id = newId('loja');
  try {
    await tx(async (db) => {
      await db.query(
        `INSERT INTO stores (id, code, name, address, lat, lng, status, created_by, location_source, location_set_by, location_set_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $5::double precision IS NULL THEN NULL ELSE 'MAP' END,
                 CASE WHEN $5::double precision IS NULL THEN NULL ELSE $8 END, CASE WHEN $5::double precision IS NULL THEN NULL ELSE NOW() END)`,
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
        `UPDATE stores SET code = COALESCE(NULLIF($2, ''), code), name = COALESCE($3, name),
           address = CASE WHEN $4::boolean THEN $5 ELSE address END,
           lat = CASE WHEN $6::boolean THEN $7::double precision ELSE lat END,
           lng = CASE WHEN $6::boolean THEN $8::double precision ELSE lng END,
           location_source = CASE WHEN $6::boolean THEN (CASE WHEN $7::double precision IS NULL THEN NULL ELSE 'MAP' END) ELSE location_source END,
           location_accuracy_m = CASE WHEN $6::boolean THEN NULL ELSE location_accuracy_m END,
           location_set_by = CASE WHEN $6::boolean THEN $10 ELSE location_set_by END,
           location_set_at = CASE WHEN $6::boolean THEN NOW() ELSE location_set_at END,
           status = COALESCE($9, status), updated_at = NOW() WHERE id = $1`,
        [s.id, body.code ?? null, body.name ?? null, body.address !== undefined, body.address || null,
          body.location !== undefined, body.location?.lat ?? null, body.location?.lng ?? null, body.status ?? null, userOf(req).id]
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

// ---------------------------------------------------------------- localização da loja pelo GPS (dentro da loja)
export const MAX_STORE_GPS_ACCURACY_M = 100;

storesRouter.put('/:id/location', requireCapability('stores.locate'), h(async (req, res) => {
  const user = userOf(req);
  if (user.apiKey) throw new HttpError(403, 'A localização da loja não pode ser registrada por chave de API.');
  assertStoreAccess(user, req.params.id);
  const body = parse(z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracyM: z.number().min(0).max(100000),
    capturedAt: z.string().datetime({ offset: true }),
    insideStore: z.literal(true, { message: 'Confirme que você está dentro da loja.' }),
  }), req.body);
  if (body.lat === 0 && body.lng === 0) throw new HttpError(400, 'Localização inválida. Tente capturar de novo.');
  if (body.accuracyM > MAX_STORE_GPS_ACCURACY_M) {
    throw new HttpError(400, `A precisão do GPS ficou em ${Math.round(body.accuracyM)} m (o máximo é ${MAX_STORE_GPS_ACCURACY_M} m). Use o celular, ative a localização precisa e tente perto da porta ou de uma janela.`);
  }
  const age = Date.now() - new Date(body.capturedAt).getTime();
  if (age > 10 * 60_000 || age < -5 * 60_000) throw new HttpError(400, 'A captura expirou. Capture a localização de novo.');
  const { rows: cur } = await pool.query('SELECT * FROM stores WHERE id = $1', [req.params.id]);
  const s = cur[0];
  if (!s) throw new HttpError(404, 'Loja não encontrada.');
  await tx(async (db) => {
    await db.query(
      `UPDATE stores SET lat = $2, lng = $3, location_source = 'GPS', location_accuracy_m = $4, location_set_by = $5, location_set_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [s.id, +body.lat.toFixed(7), +body.lng.toFixed(7), body.accuracyM, user.id]
    );
    await audit(req, {
      action: 'STORE_LOCATED', targetType: 'store', targetId: s.id, targetName: `${s.name} (${s.code})`, scope: `${s.name} (${s.code})`,
      details: `Localização registrada pelo GPS dentro da loja (precisão de ${Math.round(body.accuracyM)} m)${s.lat !== null ? '. Substituiu a localização anterior.' : '.'}`,
    }, db);
  });
  const { rows } = await pool.query(`${STORE_SQL} WHERE s.id = $1`, [s.id]);
  broadcast('data', { kind: 'stores', storeId: s.id }, s.id);
  return res.json(storeDto(rows[0]));
}));

// ---------------------------------------------------------------- pessoas da loja (gestor/administração)
async function storeUserDto(storeId: string) {
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, u.role, u.status, u.last_login_at, (u.password_hash IS NOT NULL) AS has_password
       FROM user_store_access a JOIN users u ON u.id = a.user_id WHERE a.store_id = $1 ORDER BY u.role, u.name`,
    [storeId]
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, email: r.email, role: r.role, roleLabel: ROLE_LABEL[r.role as Role], status: r.status,
    lastLoginAt: r.last_login_at, hasPassword: r.has_password,
  }));
}

storesRouter.get('/:id/users', requireCapability('users.manage'), h(async (req, res) => {
  const user = userOf(req);
  assertStoreAccess(user, req.params.id);
  const linked = await storeUserDto(req.params.id);
  // Pessoas que podem ser vinculadas (gerentes de loja e divulgadores ativos ainda não vinculados)
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, u.role FROM users u
      WHERE u.status = 'ACTIVE' AND u.role IN ('STORE_MANAGER','PROMOTER')
        AND NOT EXISTS (SELECT 1 FROM user_store_access a WHERE a.user_id = u.id AND a.store_id = $1)
      ORDER BY u.name`,
    [req.params.id]
  );
  return res.json({
    linked,
    available: rows.filter((r) => !isDeveloperEmail(r.email)).map((r) => ({ id: r.id, name: r.name, email: r.email, roleLabel: ROLE_LABEL[r.role as Role] })),
  });
}));

async function loadLinkTarget(actorRole: Role, userId: string) {
  const { rows } = await pool.query('SELECT id, name, email, role, status FROM users WHERE id = $1', [userId]);
  const u = rows[0];
  if (!u) throw new HttpError(404, 'Usuário não encontrado.');
  const role: Role = isDeveloperEmail(u.email) ? 'DEVELOPER' : u.role;
  if (MATRIX_ROLES.includes(role)) throw new HttpError(400, `${ROLE_LABEL[role]} já enxerga todas as lojas; não precisa ser vinculado.`);
  if (!assignableRoles(actorRole).includes(role)) throw new HttpError(403, 'Você não pode vincular este usuário.');
  return u;
}

storesRouter.post('/:id/users', requireCapability('users.manage'), h(async (req, res) => {
  const user = userOf(req);
  assertStoreAccess(user, req.params.id);
  const { userId } = parse(z.object({ userId: z.string() }), req.body);
  const target = await loadLinkTarget(user.role, userId);
  const scope = await storeLabel(req.params.id);
  await tx(async (db) => {
    const r = await db.query('INSERT INTO user_store_access (user_id, store_id, granted_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [target.id, req.params.id, user.id]);
    if (r.rowCount) await audit(req, { action: 'USER_STORES_CHANGED', targetType: 'user', targetId: target.id, targetName: target.email, scope, details: `Vinculado à loja ${scope}.` }, db);
  });
  dropUserStreams(target.id);
  return res.json({ linked: await storeUserDto(req.params.id) });
}));

storesRouter.delete('/:id/users/:userId', requireCapability('users.manage'), h(async (req, res) => {
  const user = userOf(req);
  assertStoreAccess(user, req.params.id);
  const target = await loadLinkTarget(user.role, req.params.userId);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM user_store_access WHERE user_id = $1', [target.id]);
  if (rows[0].n <= 1) throw new HttpError(400, 'Esta é a única loja da pessoa. Vincule outra loja antes ou bloqueie o acesso em Usuários.');
  const scope = await storeLabel(req.params.id);
  await tx(async (db) => {
    await db.query('DELETE FROM user_store_access WHERE user_id = $1 AND store_id = $2', [target.id, req.params.id]);
    await audit(req, { action: 'USER_STORES_CHANGED', targetType: 'user', targetId: target.id, targetName: target.email, scope, details: `Desvinculado da loja ${scope}.` }, db);
  });
  dropUserStreams(target.id);
  return res.json({ linked: await storeUserDto(req.params.id) });
}));
