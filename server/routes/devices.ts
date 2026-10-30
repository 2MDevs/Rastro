import { Router } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db';
import { h, HttpError, parse } from '../http';
import { audit } from '../audit';
import { requireAuth, userOf, newId, sha256, TRUST_DAYS } from '../auth/core';
import { can, SessionUser } from '../access';

export const devicesRouter = Router();
devicesRouter.use(requireAuth());

const STATUS_LABEL: Record<string, string> = { TRUSTED: 'Confiável', PENDING: 'Pendente', BLOCKED: 'Bloqueado', REVOKED: 'Revogado' };

function dto(r: any, current: string | null) {
  const expired = r.status === 'TRUSTED' && r.trusted_until && new Date(r.trusted_until) < new Date();
  return {
    id: r.id, userId: r.user_id, userName: r.user_name, name: r.name, os: r.os, browser: r.browser, deviceType: r.device_type,
    ip: r.ip, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at,
    status: expired ? 'PENDING' : r.status, statusLabel: expired ? 'Confiança expirada' : STATUS_LABEL[r.status],
    trustedUntil: r.trusted_until, activeSessions: Number(r.active_sessions || 0), current: r.id === current,
  };
}

async function currentDeviceId(req: any): Promise<string | null> {
  const { rows } = await pool.query('SELECT device_id FROM sessions WHERE id = $1', [userOf(req).sessionId]);
  return rows[0]?.device_id ?? null;
}

devicesRouter.get('/', h(async (req, res) => {
  const user = userOf(req);
  const all = can(user.role, 'devices.manage') && req.query.mine !== 'true';
  const { rows } = await pool.query(
    `SELECT d.*, u.name AS user_name,
       (SELECT COUNT(*) FROM sessions s WHERE s.device_id = d.id AND s.revoked_at IS NULL AND s.expires_at > NOW()) AS active_sessions
       FROM auth_devices d JOIN users u ON u.id = d.user_id
      WHERE ($1::boolean OR d.user_id = $2) ORDER BY d.last_seen_at DESC LIMIT 1000`,
    [all, user.id]
  );
  const current = await currentDeviceId(req);
  return res.json({ devices: rows.map((r) => dto(r, current)), scope: all ? 'all' : 'mine' });
}));

async function loadDevice(user: SessionUser, id: string, needsManage: boolean) {
  const { rows } = await pool.query('SELECT d.*, u.name AS user_name FROM auth_devices d JOIN users u ON u.id = d.user_id WHERE d.id = $1', [id]);
  const d = rows[0];
  const manager = can(user.role, 'devices.manage');
  if (!d || (d.user_id !== user.id && !manager)) throw new HttpError(404, 'Dispositivo não encontrado.');
  if (needsManage && !manager) throw new HttpError(403, 'Só a administração pode fazer isto.');
  return d;
}

devicesRouter.post('/:id/approve', h(async (req, res) => {
  const user = userOf(req);
  const d = await loadDevice(user, req.params.id, false);
  if (d.status === 'BLOCKED' && !can(user.role, 'devices.manage')) throw new HttpError(403, 'Este dispositivo foi bloqueado pela administração.');
  await tx(async (db) => {
    await db.query(`UPDATE auth_devices SET status = 'TRUSTED', trusted_until = NOW() + make_interval(days => $2) WHERE id = $1`, [d.id, TRUST_DAYS]);
    await audit(req, { action: 'DEVICE_APPROVED', targetType: 'device', targetId: d.id, targetName: `${d.name} — ${d.user_name}`, details: `Confiável por ${TRUST_DAYS} dias.` }, db);
  });
  return res.json({ ok: true });
}));

devicesRouter.post('/:id/revoke', h(async (req, res) => {
  const user = userOf(req);
  const d = await loadDevice(user, req.params.id, false);
  await tx(async (db) => {
    await db.query(`UPDATE auth_devices SET status = CASE WHEN status = 'BLOCKED' THEN status ELSE 'REVOKED' END, trusted_until = NULL WHERE id = $1`, [d.id]);
    await db.query('UPDATE sessions SET revoked_at = NOW() WHERE device_id = $1 AND revoked_at IS NULL', [d.id]);
    await audit(req, { action: 'DEVICE_REVOKED', targetType: 'device', targetId: d.id, targetName: `${d.name} — ${d.user_name}`,
      details: 'Confiança revogada e sessões deste dispositivo encerradas. O próximo acesso pedirá o código por e-mail.' }, db);
  });
  return res.json({ ok: true });
}));

devicesRouter.post('/:id/block', h(async (req, res) => {
  const user = userOf(req);
  const d = await loadDevice(user, req.params.id, true);
  const blocked = req.body?.blocked !== false;
  await tx(async (db) => {
    if (blocked) {
      await db.query(`UPDATE auth_devices SET status = 'BLOCKED', trusted_until = NULL WHERE id = $1`, [d.id]);
      await db.query('UPDATE sessions SET revoked_at = NOW() WHERE device_id = $1 AND revoked_at IS NULL', [d.id]);
    } else {
      await db.query(`UPDATE auth_devices SET status = 'REVOKED' WHERE id = $1 AND status = 'BLOCKED'`, [d.id]);
    }
    await audit(req, { action: blocked ? 'DEVICE_BLOCKED' : 'DEVICE_REVOKED', targetType: 'device', targetId: d.id, targetName: `${d.name} — ${d.user_name}`,
      details: blocked ? 'Dispositivo bloqueado e sessões encerradas.' : 'Bloqueio retirado (o próximo acesso pedirá o código por e-mail).' }, db);
  });
  return res.json({ ok: true });
}));

devicesRouter.delete('/:id', h(async (req, res) => {
  const user = userOf(req);
  const d = await loadDevice(user, req.params.id, false);
  if (d.status === 'BLOCKED' && !can(user.role, 'devices.manage')) throw new HttpError(403, 'Este dispositivo foi bloqueado pela administração.');
  await tx(async (db) => {
    await db.query('UPDATE sessions SET revoked_at = NOW() WHERE device_id = $1 AND revoked_at IS NULL', [d.id]);
    await db.query('DELETE FROM auth_devices WHERE id = $1', [d.id]);
    await audit(req, { action: 'DEVICE_REMOVED', targetType: 'device', targetId: d.id, targetName: `${d.name} — ${d.user_name}`, details: 'Dispositivo removido e sessões encerradas.' }, db);
  });
  return res.json({ ok: true });
}));

// ---------------------------------------------------------------- aparelhos de rastreamento
export const trackersRouter = Router();
trackersRouter.use(requireAuth());

const KIND_LABEL: Record<string, string> = { WEB_FIELD: 'Modo campo (navegador)', ANDROID_APP: 'App Android', GPS_DEVICE: 'Equipamento GPS dedicado' };
const TRACKER_STATUS: Record<string, string> = { ACTIVE: 'Ativo', BLOCKED: 'Bloqueado', REVOKED: 'Revogado' };

trackersRouter.get('/', h(async (req, res) => {
  const user = userOf(req);
  const all = can(user.role, 'devices.manage');
  const { rows } = await pool.query(
    `SELECT d.*, u.name AS user_name,
       (SELECT COUNT(*) FROM tracking_sessions t WHERE t.tracker_device_id = d.id) AS sessions,
       (SELECT COUNT(*) FROM tracking_sessions t WHERE t.tracker_device_id = d.id AND t.status = 'IN_PROGRESS') AS live
       FROM tracker_devices d LEFT JOIN users u ON u.id = d.user_id
      WHERE ($1::boolean OR d.user_id = $2) ORDER BY d.last_seen_at DESC NULLS LAST`,
    [all, user.id]
  );
  return res.json(rows.map((r) => ({
    id: r.id, kind: r.kind, kindLabel: KIND_LABEL[r.kind], name: r.name, userId: r.user_id, userName: r.user_name,
    status: r.status, statusLabel: TRACKER_STATUS[r.status], appVersion: r.app_version, lastIp: r.last_ip,
    createdAt: r.created_at, lastSeenAt: r.last_seen_at, sessions: Number(r.sessions), live: Number(r.live) > 0,
  })));
}));

/** Cadastro de equipamento GPS dedicado (o adaptador do fabricante usa uma chave de API para enviar os pontos) */
trackersRouter.post('/', h(async (req, res) => {
  const user = userOf(req);
  if (!can(user.role, 'devices.manage')) throw new HttpError(403, 'Só a administração cadastra equipamentos.');
  const body = parse(z.object({
    name: z.string().trim().min(2).max(80),
    identifier: z.string().trim().min(4, 'Informe o identificador do equipamento (ex.: IMEI ou número de série).').max(128),
    userId: z.string(),
  }), req.body);
  const { rows: ur } = await pool.query(`SELECT id FROM users WHERE id = $1 AND status = 'ACTIVE'`, [body.userId]);
  if (!ur[0]) throw new HttpError(400, 'Escolha uma pessoa ativa como responsável pelo equipamento.');
  const id = newId('apr');
  try {
    await pool.query(
      `INSERT INTO tracker_devices (id, user_id, kind, name, install_hash) VALUES ($1, $2, 'GPS_DEVICE', $3, $4)`,
      [id, body.userId, body.name, sha256(body.identifier)]
    );
  } catch (err: any) {
    if (err?.code === '23505') throw new HttpError(409, 'Este equipamento já está cadastrado.');
    throw err;
  }
  await audit(req, { action: 'TRACKER_REGISTERED', targetType: 'tracker', targetId: id, targetName: body.name, details: 'Equipamento GPS dedicado cadastrado.' });
  return res.status(201).json({ id });
}));

trackersRouter.post('/:id/status', h(async (req, res) => {
  const user = userOf(req);
  const { status } = parse(z.object({ status: z.enum(['ACTIVE', 'BLOCKED', 'REVOKED']) }), req.body);
  const { rows } = await pool.query('SELECT * FROM tracker_devices WHERE id = $1', [req.params.id]);
  const d = rows[0];
  const manager = can(user.role, 'devices.manage');
  if (!d || (!manager && d.user_id !== user.id)) throw new HttpError(404, 'Aparelho não encontrado.');
  if (!manager && status !== 'REVOKED') throw new HttpError(403, 'Só a administração pode bloquear ou reativar aparelhos.');
  await tx(async (db) => {
    await db.query('UPDATE tracker_devices SET status = $2 WHERE id = $1', [d.id, status]);
    if (status !== 'ACTIVE') {
      // Rastreamentos em andamento neste aparelho são interrompidos
      await db.query(
        `UPDATE tracking_sessions SET status = 'INTERRUPTED', finished_at = NOW(), finish_reason = $2 WHERE tracker_device_id = $1 AND status = 'IN_PROGRESS'`,
        [d.id, `Aparelho ${status === 'BLOCKED' ? 'bloqueado' : 'revogado'} por ${user.auditName}`]
      );
    }
    await audit(req, { action: status === 'ACTIVE' ? 'TRACKER_ACTIVATED' : status === 'BLOCKED' ? 'TRACKER_BLOCKED' : 'TRACKER_REVOKED',
      targetType: 'tracker', targetId: d.id, targetName: d.name }, db);
  });
  return res.json({ ok: true });
}));
