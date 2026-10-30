import { Router } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db';
import { h, HttpError, parse } from '../http';
import { audit } from '../audit';
import { requireAuth, requireCapability, userOf, newId, revokeUserSessions } from '../auth/core';
import { createPasswordLink } from '../auth/routes';
import { assignableRoles, isDeveloperEmail, MATRIX_ROLES, ROLE_LABEL, ROLES, Role } from '../access';
import { dropUserStreams } from '../services/realtime';

export const usersRouter = Router();
usersRouter.use(requireAuth(), requireCapability('users.manage'));

const maskPhone = (p: string | null) => (p ? p.replace(/\d(?=\d{4})/g, '•') : null);

function toDto(r: any) {
  const role: Role = isDeveloperEmail(r.email) ? 'DEVELOPER' : r.role;
  return {
    id: r.id, name: r.name, email: r.email, phone: maskPhone(r.phone), role, roleLabel: ROLE_LABEL[role],
    status: r.status, hasPassword: Boolean(r.password_hash), lastLoginAt: r.last_login_at, createdAt: r.created_at,
    stores: r.stores ?? [], lockedUntil: r.locked_until && new Date(r.locked_until) > new Date() ? r.locked_until : null,
    activeSessions: Number(r.active_sessions || 0),
  };
}

const LIST_SQL = `
  SELECT u.*,
    COALESCE((SELECT json_agg(json_build_object('id', s.id, 'code', s.code, 'name', s.name) ORDER BY s.name)
                FROM user_store_access a JOIN stores s ON s.id = a.store_id WHERE a.user_id = u.id), '[]') AS stores,
    (SELECT COUNT(*) FROM sessions x WHERE x.user_id = u.id AND x.revoked_at IS NULL AND x.expires_at > NOW()) AS active_sessions
  FROM users u`;

usersRouter.get('/', h(async (req, res) => {
  const { rows } = await pool.query(`${LIST_SQL} ORDER BY u.status, u.name`);
  return res.json({ users: rows.map(toDto), assignableRoles: assignableRoles(userOf(req).role).map((r) => ({ value: r, label: ROLE_LABEL[r] })) });
}));

const UserInput = z.object({
  name: z.string().trim().min(2, 'Informe o nome.').max(120),
  email: z.string().trim().toLowerCase().email('Informe um e-mail válido.').max(200),
  phone: z.string().trim().max(30).optional().nullable(),
  role: z.enum(ROLES),
  storeIds: z.array(z.string()).max(500),
});
const UserCreate = UserInput.extend({ storeIds: z.array(z.string()).max(500).default([]) });

async function validateStores(storeIds: string[]) {
  if (!storeIds.length) return;
  const { rows } = await pool.query('SELECT id FROM stores WHERE id = ANY($1::text[])', [storeIds]);
  if (rows.length !== new Set(storeIds).size) throw new HttpError(400, 'Uma das lojas escolhidas não existe.');
}

function checkRoleAllowed(actorRole: Role, role: Role) {
  if (!assignableRoles(actorRole).includes(role)) throw new HttpError(403, `Você não pode atribuir o perfil ${ROLE_LABEL[role]}.`);
}

usersRouter.post('/', h(async (req, res) => {
  const actor = userOf(req);
  const body = parse(UserCreate, req.body);
  checkRoleAllowed(actor.role, body.role);
  if (!MATRIX_ROLES.includes(body.role) && body.storeIds.length === 0) {
    throw new HttpError(400, 'Gerente de loja e divulgador precisam estar vinculados a pelo menos uma loja.');
  }
  await validateStores(body.storeIds);
  const id = newId('usr');
  try {
    await tx(async (db) => {
      await db.query(
        `INSERT INTO users (id, name, email, phone, role) VALUES ($1, $2, $3, $4, $5)`,
        [id, body.name, body.email, body.phone || null, body.role]
      );
      if (!MATRIX_ROLES.includes(body.role)) {
        for (const s of new Set(body.storeIds)) {
          await db.query('INSERT INTO user_store_access (user_id, store_id, granted_by) VALUES ($1, $2, $3)', [id, s, actor.id]);
        }
      }
      await audit(req, {
        action: 'USER_CREATED', targetType: 'user', targetId: id, targetName: body.email,
        details: `Perfil: ${ROLE_LABEL[body.role]}. Lojas: ${MATRIX_ROLES.includes(body.role) ? 'todas (Matriz)' : body.storeIds.length}.`,
      }, db);
    });
  } catch (err: any) {
    if (err?.code === '23505') throw new HttpError(409, 'Já existe um usuário com este e-mail.');
    throw err;
  }
  // Acesso inicial: link para a pessoa criar a própria senha (ninguém conhece a senha dela)
  let inviteSent = false;
  try {
    await createPasswordLink({ id, name: body.name, email: body.email }, 'invite', req);
    inviteSent = true;
    await audit(req, { action: 'USER_INVITE_SENT', targetType: 'user', targetId: id, targetName: body.email, details: 'Link de criação de senha enviado.' });
  } catch {
    inviteSent = false;
  }
  const { rows } = await pool.query(`${LIST_SQL} WHERE u.id = $1`, [id]);
  return res.status(201).json({ user: toDto(rows[0]), inviteSent });
}));

usersRouter.patch('/:id', h(async (req, res) => {
  const actor = userOf(req);
  const body = parse(UserInput.partial(), req.body);
  const { rows: cur } = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  const target = cur[0];
  if (!target) throw new HttpError(404, 'Usuário não encontrado.');
  const targetRole: Role = isDeveloperEmail(target.email) ? 'DEVELOPER' : target.role;
  checkRoleAllowed(actor.role, targetRole);
  if (body.role) checkRoleAllowed(actor.role, body.role);
  if (body.storeIds) await validateStores(body.storeIds);
  const newRole = body.role ?? target.role;
  const changes: string[] = [];
  try {
    await tx(async (db) => {
      await db.query(
        `UPDATE users SET name = COALESCE($2, name), email = COALESCE($3, email), phone = CASE WHEN $4::boolean THEN $5 ELSE phone END,
           role = COALESCE($6, role), updated_at = NOW() WHERE id = $1`,
        [target.id, body.name ?? null, body.email ?? null, body.phone !== undefined, body.phone || null, body.role ?? null]
      );
      if (body.name && body.name !== target.name) changes.push('nome');
      if (body.email && body.email !== target.email) changes.push('e-mail');
      if (body.phone !== undefined) changes.push('telefone');
      if (body.role && body.role !== target.role) changes.push(`perfil: ${ROLE_LABEL[target.role as Role]} → ${ROLE_LABEL[body.role]}`);
      const scopeChanged = body.role !== undefined && MATRIX_ROLES.includes(body.role) !== MATRIX_ROLES.includes(target.role);
      if (body.storeIds !== undefined || scopeChanged) {
        await db.query('DELETE FROM user_store_access WHERE user_id = $1', [target.id]);
        if (!MATRIX_ROLES.includes(newRole)) {
          if (!body.storeIds?.length) {
            throw new HttpError(400, 'Gerente de loja e divulgador precisam estar vinculados a pelo menos uma loja.');
          }
          for (const s of new Set(body.storeIds)) {
            await db.query('INSERT INTO user_store_access (user_id, store_id, granted_by) VALUES ($1, $2, $3)', [target.id, s, actor.id]);
          }
        }
        changes.push('lojas');
      }
      await audit(req, { action: 'USER_UPDATED', targetType: 'user', targetId: target.id, targetName: target.email, details: `Alterado: ${changes.join(', ') || 'nada'}.` }, db);
    });
  } catch (err: any) {
    if (err?.code === '23505') throw new HttpError(409, 'Já existe um usuário com este e-mail.');
    throw err;
  }
  // Mudou perfil ou lojas: a pessoa precisa recarregar as permissões (os canais em tempo real são refeitos)
  if (changes.some((c) => c.startsWith('perfil') || c === 'lojas')) dropUserStreams(target.id);
  const { rows } = await pool.query(`${LIST_SQL} WHERE u.id = $1`, [target.id]);
  return res.json({ user: toDto(rows[0]) });
}));

usersRouter.post('/:id/block', h(async (req, res) => {
  const actor = userOf(req);
  if (req.params.id === actor.id) throw new HttpError(400, 'Você não pode bloquear o seu próprio acesso.');
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  const target = rows[0];
  if (!target) throw new HttpError(404, 'Usuário não encontrado.');
  checkRoleAllowed(actor.role, isDeveloperEmail(target.email) ? 'DEVELOPER' : target.role);
  const blocked = req.body?.blocked !== false;
  await tx(async (db) => {
    await db.query(`UPDATE users SET status = $2, updated_at = NOW() WHERE id = $1`, [target.id, blocked ? 'BLOCKED' : 'ACTIVE']);
    if (blocked) {
      // Perde todas as sessões na hora
      await revokeUserSessions(target.id, undefined, db);
    }
    await audit(req, { action: blocked ? 'USER_BLOCKED' : 'USER_UNBLOCKED', targetType: 'user', targetId: target.id, targetName: target.email,
      details: blocked ? 'Acesso bloqueado. Todas as sessões foram encerradas.' : 'Acesso liberado.' }, db);
  });
  if (blocked) dropUserStreams(target.id);
  return res.json({ ok: true });
}));

usersRouter.post('/:id/send-access', h(async (req, res) => {
  const actor = userOf(req);
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  const target = rows[0];
  if (!target) throw new HttpError(404, 'Usuário não encontrado.');
  checkRoleAllowed(actor.role, isDeveloperEmail(target.email) ? 'DEVELOPER' : target.role);
  if (target.status !== 'ACTIVE') throw new HttpError(400, 'Desbloqueie o usuário antes de enviar o acesso.');
  const purpose = target.password_hash ? 'reset' : 'invite';
  await createPasswordLink(target, purpose, req);
  await audit(req, { action: 'USER_INVITE_SENT', targetType: 'user', targetId: target.id, targetName: target.email,
    details: purpose === 'invite' ? 'Link de criação de senha reenviado.' : 'Link de redefinição de senha enviado pela administração.' });
  return res.json({ ok: true });
}));

