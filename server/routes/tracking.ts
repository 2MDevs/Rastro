import { Router } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db';
import { h, HttpError, parse, clientIp, sendCsv } from '../http';
import { audit } from '../audit';
import { requireAuth, requireCapability, userOf, newId, sha256 } from '../auth/core';
import { assertStoreAccess, can, hasStoreAccess, scopeSql, storeLabel, SessionUser } from '../access';
import { getInt } from '../settings';
import { sessionTrack, scheduleCoverage, trackParams } from '../services/coverage';
import { buildTrack } from '../services/geo';
import { broadcast } from '../services/realtime';
import { emitWebhook } from '../services/webhooks';

/**
 * Rastreamento GPS.
 * Quem envia: modo campo no navegador, app Android (futuro) e equipamentos dedicados por adaptador
 * (com chave de API de escopo tracking:write). Todos usam as mesmas regras abaixo.
 */
export const trackingRouter = Router();
trackingRouter.use(requireAuth({ apiKeyScopes: ['tracking:read', 'tracking:write'] }));

export const SESSION_STATE_LABEL: Record<string, string> = {
  WAITING: 'Aguardando',
  IN_PROGRESS: 'Em andamento',
  NO_COMMUNICATION: 'Sem comunicação',
  SYNC_PENDING: 'Sincronizando',
  FINISHED: 'Concluída',
  INTERRUPTED: 'Interrompida',
};

export function sessionState(r: any, staleMinutes: number): keyof typeof SESSION_STATE_LABEL {
  if (r.status === 'IN_PROGRESS') {
    const ref = r.last_point_received_at ?? r.started_at;
    if (ref && Date.now() - new Date(ref).getTime() > staleMinutes * 60_000) return 'NO_COMMUNICATION';
    return 'IN_PROGRESS';
  }
  if (r.status === 'FINISHED' && r.pending_points_reported > 0) return 'SYNC_PENDING';
  return r.status;
}

const SESSION_SQL = `
  SELECT t.*, u.name AS user_name, c.name AS campaign_name, s.name AS store_name, s.code AS store_code,
         d.name AS device_name, d.kind AS device_kind
    FROM tracking_sessions t
    JOIN users u ON u.id = t.user_id
    JOIN campaigns c ON c.id = t.campaign_id
    JOIN stores s ON s.id = t.store_id
    LEFT JOIN tracker_devices d ON d.id = t.tracker_device_id`;

export function sessionDto(r: any, stale: number) {
  const state = sessionState(r, stale);
  return {
    id: r.id, campaignId: r.campaign_id, campaignName: r.campaign_name, storeId: r.store_id, storeName: r.store_name, storeCode: r.store_code,
    userId: r.user_id, userName: r.user_name, device: r.device_name ? { name: r.device_name, kind: r.device_kind } : null,
    status: r.status, state, stateLabel: SESSION_STATE_LABEL[state],
    startedAt: r.started_at, finishedAt: r.finished_at, finishReason: r.finish_reason,
    pointsCount: r.points_count, acceptedPoints: r.accepted_points, pendingPointsReported: r.pending_points_reported,
    lastPointCapturedAt: r.last_point_captured_at, lastPointReceivedAt: r.last_point_received_at,
    lastPosition: r.last_lat === null ? null : { lat: r.last_lat, lng: r.last_lng, accuracyM: r.last_accuracy_m },
  };
}

function canSeeSession(user: SessionUser, r: any) {
  if (!hasStoreAccess(user, r.store_id)) return false;
  return r.user_id === user.id || can(user.role, 'tracking.view');
}

async function loadSession(user: SessionUser, id: string) {
  const { rows } = await pool.query(`${SESSION_SQL} WHERE t.id = $1`, [id]);
  const r = rows[0];
  if (!r || !canSeeSession(user, r)) throw new HttpError(404, 'Percurso não encontrado.');
  return r;
}

// ---------------------------------------------------------------- aparelhos de coleta
trackingRouter.post('/devices/register', h(async (req, res) => {
  const user = userOf(req);
  if (user.apiKey) throw new HttpError(403, 'Equipamentos dedicados são cadastrados pela administração na tela Dispositivos.');
  const body = parse(z.object({
    kind: z.enum(['WEB_FIELD', 'ANDROID_APP']),
    installId: z.string().min(16).max(128),
    name: z.string().trim().min(1).max(80),
    appVersion: z.string().max(40).optional(),
  }), req.body);
  const hash = sha256(body.installId);
  const { rows } = await pool.query('SELECT * FROM tracker_devices WHERE kind = $1 AND install_hash = $2', [body.kind, hash]);
  if (rows[0]) {
    const d = rows[0];
    if (d.status !== 'ACTIVE') {
      await audit(req, { action: 'TRACKING_DENIED', result: 'BLOCKED', targetType: 'tracker', targetId: d.id, targetName: d.name, details: 'Aparelho bloqueado ou revogado tentou se registrar.' });
      throw new HttpError(403, 'Este aparelho está bloqueado para rastreamento. Fale com a administração.');
    }
    await pool.query('UPDATE tracker_devices SET user_id = $2, name = $3, app_version = $4, last_seen_at = NOW(), last_ip = $5 WHERE id = $1',
      [d.id, user.id, body.name, body.appVersion ?? null, clientIp(req)]);
    return res.json({ id: d.id });
  }
  const id = newId('apr');
  await pool.query(
    `INSERT INTO tracker_devices (id, user_id, kind, name, install_hash, app_version, last_seen_at, last_ip) VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7)`,
    [id, user.id, body.kind, body.name, hash, body.appVersion ?? null, clientIp(req)]
  );
  await audit(req, { action: 'TRACKER_REGISTERED', targetType: 'tracker', targetId: id, targetName: body.name,
    details: body.kind === 'WEB_FIELD' ? 'Modo campo (navegador).' : 'App Android.' });
  return res.status(201).json({ id });
}));

/** Campanhas ativas em que a pessoa é responsável (tela do modo campo) */
trackingRouter.get('/my-campaigns', h(async (req, res) => {
  const user = userOf(req);
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.status, c.start_date, c.end_date, s.id AS store_id, s.name AS store_name, s.code AS store_code,
            (SELECT COUNT(*) FROM planned_streets p WHERE p.campaign_id = c.id) AS streets
       FROM campaigns c JOIN stores s ON s.id = c.store_id
       JOIN campaign_assignments a ON a.campaign_id = c.id AND a.user_id = $1
      WHERE c.status IN ('ACTIVE','PAUSED','PLANNED') ORDER BY (c.status = 'ACTIVE') DESC, c.name`,
    [user.id]
  );
  const stale = await getInt('TRACKING_STALE_MINUTES');
  const open = await pool.query(`${SESSION_SQL} WHERE t.user_id = $1 AND t.status = 'IN_PROGRESS' ORDER BY t.started_at DESC LIMIT 1`, [user.id]);
  return res.json({
    campaigns: rows.filter((r) => hasStoreAccess(user, r.store_id)).map((r) => ({
      id: r.id, name: r.name, status: r.status, canTrack: r.status === 'ACTIVE', startDate: r.start_date, endDate: r.end_date,
      store: { id: r.store_id, name: r.store_name, code: r.store_code }, streets: Number(r.streets),
    })),
    openSession: open.rows[0] ? sessionDto(open.rows[0], stale) : null,
  });
}));

// ---------------------------------------------------------------- sessões
trackingRouter.post('/sessions', h(async (req, res) => {
  const user = userOf(req);
  if (user.apiKey && !user.apiKey.scopes.includes('tracking:write')) throw new HttpError(403, 'Esta chave não pode enviar rastreamento.');
  const body = parse(z.object({
    clientSessionId: z.string().min(8).max(100),
    campaignId: z.string(),
    trackerDeviceId: z.string(),
    startedAt: z.string().datetime({ offset: true }).optional(),
  }), req.body);

  // Repetição do mesmo pedido (internet instável): devolve a sessão já criada
  const existing = await pool.query(`${SESSION_SQL} WHERE t.client_session_id = $1`, [body.clientSessionId]);
  if (existing.rows[0]) {
    if (existing.rows[0].user_id !== user.id) throw new HttpError(409, 'Identificador de sessão já usado.');
    return res.json(sessionDto(existing.rows[0], await getInt('TRACKING_STALE_MINUTES')));
  }

  const { rows: cr } = await pool.query(
    `SELECT c.*, EXISTS (SELECT 1 FROM campaign_assignments a WHERE a.campaign_id = c.id AND a.user_id = $2) AS assigned
       FROM campaigns c WHERE c.id = $1`,
    [body.campaignId, user.id]
  );
  const c = cr[0];
  if (!c || !hasStoreAccess(user, c.store_id)) throw new HttpError(404, 'Campanha não encontrada.');
  const scope = await storeLabel(c.store_id);
  const deny = async (msg: string) => {
    await audit(req, { action: 'TRACKING_DENIED', result: 'DENIED', targetType: 'campaign', targetId: c.id, targetName: c.name, scope, details: msg });
    throw new HttpError(403, msg);
  };
  if (!c.assigned) await deny('Você não é responsável por esta campanha.');
  if (c.status !== 'ACTIVE') await deny('Esta campanha não está ativa. O rastreamento só pode começar em campanhas ativas.');

  const { rows: dr } = await pool.query('SELECT * FROM tracker_devices WHERE id = $1', [body.trackerDeviceId]);
  const d = dr[0];
  if (!d) throw new HttpError(400, 'Aparelho não registrado. Abra o modo campo de novo.');
  if (d.status !== 'ACTIVE') await deny('Este aparelho está bloqueado para rastreamento.');
  if (d.user_id !== user.id) await deny('Este aparelho está registrado para outra pessoa.');

  const open = await pool.query(`SELECT id FROM tracking_sessions WHERE user_id = $1 AND status = 'IN_PROGRESS'`, [user.id]);
  if (open.rows[0]) throw new HttpError(409, 'Você já tem um rastreamento em andamento. Encerre-o antes de começar outro.', 'SESSION_OPEN');

  // Horário de início: o informado pelo aparelho (se plausível) ou o do servidor
  let startedAt = new Date();
  if (body.startedAt) {
    const t = new Date(body.startedAt);
    if (t.getTime() <= Date.now() + 5 * 60_000 && t.getTime() >= Date.now() - 24 * 3600_000) startedAt = t;
  }
  const id = newId('ses');
  await tx(async (db) => {
    await db.query(
      `INSERT INTO tracking_sessions (id, client_session_id, campaign_id, store_id, user_id, tracker_device_id, status, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,'IN_PROGRESS',$7)`,
      [id, body.clientSessionId, c.id, c.store_id, user.id, d.id, startedAt]
    );
    await db.query('UPDATE tracker_devices SET last_seen_at = NOW(), last_ip = $2 WHERE id = $1', [d.id, clientIp(req)]);
    await audit(req, { action: 'TRACKING_STARTED', targetType: 'session', targetId: id, targetName: c.name, scope, details: `Aparelho: ${d.name}.` }, db);
  });
  const { rows } = await pool.query(`${SESSION_SQL} WHERE t.id = $1`, [id]);
  const dto = sessionDto(rows[0], await getInt('TRACKING_STALE_MINUTES'));
  broadcast('tracking', { type: 'session', session: dto }, c.store_id, (u) => can(u.role, 'tracking.view') || u.id === user.id);
  emitWebhook('tracking.session.started', { sessionId: id, campaignId: c.id, storeId: c.store_id, startedAt });
  return res.status(201).json(dto);
}));

const PointInput = z.object({
  id: z.string().min(1).max(100),
  lat: z.number(),
  lng: z.number(),
  accuracy: z.number().nullable().optional(),
  altitude: z.number().nullable().optional(),
  speed: z.number().nullable().optional(),
  heading: z.number().nullable().optional(),
  capturedAt: z.string().datetime({ offset: true }),
});

/** Recebe um lote de pontos. Repetições do mesmo ponto (mesmo id) são ignoradas. */
trackingRouter.post('/sessions/:id/points', h(async (req, res) => {
  const user = userOf(req);
  if (user.apiKey && !user.apiKey.scopes.includes('tracking:write')) throw new HttpError(403, 'Esta chave não pode enviar rastreamento.');
  const { points, pendingPoints } = parse(z.object({
    points: z.array(PointInput).max(500, 'Envie no máximo 500 pontos por vez.'),
    pendingPoints: z.number().int().min(0).max(1_000_000).optional(),
  }), req.body);
  const { rows: sr } = await pool.query('SELECT * FROM tracking_sessions WHERE id = $1', [req.params.id]);
  const s = sr[0];
  if (!s || s.user_id !== user.id) throw new HttpError(404, 'Sessão de rastreamento não encontrada.');
  if (s.status === 'WAITING') throw new HttpError(409, 'Esta sessão ainda não começou.');
  const { rows: dr } = await pool.query('SELECT status FROM tracker_devices WHERE id = $1', [s.tracker_device_id]);
  if (dr[0] && dr[0].status !== 'ACTIVE') {
    await audit(req, { action: 'TRACKING_DENIED', result: 'BLOCKED', targetType: 'session', targetId: s.id, details: 'Pontos recusados: aparelho bloqueado.' });
    throw new HttpError(403, 'Este aparelho está bloqueado para rastreamento.');
  }

  const now = Date.now();
  const startMs = new Date(s.started_at).getTime();
  const endMs = s.finished_at ? new Date(s.finished_at).getTime() : null;
  let inserted = 0, rejected = 0;
  let newest: any = null;
  await tx(async (db) => {
    for (const p of points) {
      const t = new Date(p.capturedAt).getTime();
      let reason: string | null = null;
      if (!(Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180) || (p.lat === 0 && p.lng === 0)) reason = 'Coordenada inválida';
      else if (t > now + 5 * 60_000) reason = 'Horário no futuro';
      else if (t < startMs - 10 * 60_000) reason = 'Antes do início da sessão';
      else if (endMs !== null && t > endMs + 2 * 60_000) reason = 'Depois do encerramento da sessão';
      const acc = p.accuracy !== null && p.accuracy !== undefined && p.accuracy >= 0 ? Math.min(p.accuracy, 1e6) : null;
      const lat = Number.isFinite(p.lat) ? Math.max(-90, Math.min(90, p.lat)) : 0;
      const lng = Number.isFinite(p.lng) ? Math.max(-180, Math.min(180, p.lng)) : 0;
      const r = await db.query(
        `INSERT INTO gps_points (session_id, client_point_id, lat, lng, accuracy_m, altitude_m, speed_mps, heading_deg, captured_at, accepted, reject_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (session_id, client_point_id) DO NOTHING`,
        [s.id, p.id, lat, lng, acc, p.altitude ?? null, p.speed ?? null, p.heading ?? null, new Date(t), reason === null, reason]
      );
      if (r.rowCount) {
        inserted++;
        if (reason) rejected++;
        else if (!newest || t > newest.t) newest = { t, lat, lng, acc };
      }
    }
    if (inserted || pendingPoints !== undefined) {
      await db.query(
        `UPDATE tracking_sessions SET
           points_count = points_count + $2, accepted_points = accepted_points + $3,
           last_point_received_at = CASE WHEN $2 > 0 THEN NOW() ELSE last_point_received_at END,
           last_point_captured_at = CASE WHEN $4::timestamptz IS NOT NULL AND ($4::timestamptz > last_point_captured_at OR last_point_captured_at IS NULL) THEN $4::timestamptz ELSE last_point_captured_at END,
           last_lat = CASE WHEN $4::timestamptz IS NOT NULL AND ($4::timestamptz >= last_point_captured_at OR last_point_captured_at IS NULL) THEN $5 ELSE last_lat END,
           last_lng = CASE WHEN $4::timestamptz IS NOT NULL AND ($4::timestamptz >= last_point_captured_at OR last_point_captured_at IS NULL) THEN $6 ELSE last_lng END,
           last_accuracy_m = CASE WHEN $4::timestamptz IS NOT NULL AND ($4::timestamptz >= last_point_captured_at OR last_point_captured_at IS NULL) THEN $7 ELSE last_accuracy_m END,
           pending_points_reported = CASE WHEN $8::int IS NOT NULL THEN $8 ELSE GREATEST(0, pending_points_reported - $2) END
         WHERE id = $1`,
        [s.id, inserted, inserted - rejected, newest ? new Date(newest.t) : null, newest?.lat ?? null, newest?.lng ?? null, newest?.acc ?? null,
          pendingPoints ?? null]
      );
    }
  });
  await pool.query('UPDATE tracker_devices SET last_seen_at = NOW(), last_ip = $2 WHERE id = $1', [s.tracker_device_id, clientIp(req)]).catch(() => {});

  if (newest) {
    broadcast('tracking', {
      type: 'position', sessionId: s.id, campaignId: s.campaign_id, userId: s.user_id,
      position: { lat: newest.lat, lng: newest.lng, accuracyM: newest.acc, capturedAt: new Date(newest.t).toISOString() },
    }, s.store_id, (u) => can(u.role, 'tracking.view') || u.id === s.user_id);
  }
  if (inserted && s.status !== 'IN_PROGRESS') scheduleCoverage(s.campaign_id); // pontos que chegaram depois do fim
  return res.json({ received: points.length, inserted, duplicates: points.length - inserted, rejected });
}));

trackingRouter.post('/sessions/:id/finish', h(async (req, res) => {
  const user = userOf(req);
  const body = parse(z.object({
    reason: z.enum(['USER', 'INTERRUPTED']).default('USER'),
    note: z.string().max(300).optional(),
    pendingPoints: z.number().int().min(0).max(1_000_000).optional(),
    finishedAt: z.string().datetime({ offset: true }).optional(),
  }), req.body ?? {});
  const { rows: sr } = await pool.query('SELECT * FROM tracking_sessions WHERE id = $1', [req.params.id]);
  const s = sr[0];
  // A própria pessoa encerra; gestores com acesso à loja também podem encerrar uma sessão esquecida
  const manager = s && can(user.role, 'campaigns.manage') && hasStoreAccess(user, s.store_id);
  if (!s || (s.user_id !== user.id && !manager)) throw new HttpError(404, 'Sessão de rastreamento não encontrada.');
  if (s.status !== 'IN_PROGRESS') return res.json({ ok: true, alreadyFinished: true });
  const status = body.reason === 'INTERRUPTED' ? 'INTERRUPTED' : 'FINISHED';
  let finishedAt = new Date();
  if (body.finishedAt) {
    const t = new Date(body.finishedAt);
    if (t.getTime() <= Date.now() + 5 * 60_000 && t >= new Date(s.started_at)) finishedAt = t;
  }
  const reasonText = s.user_id !== user.id
    ? `Encerrada por ${user.auditName}${body.note ? `: ${body.note}` : ''}`
    : body.note || (status === 'INTERRUPTED' ? 'Interrompida no aparelho' : 'Encerrada pela pessoa');
  await tx(async (db) => {
    await db.query(
      `UPDATE tracking_sessions SET status = $2, finished_at = $3, finish_reason = $4, pending_points_reported = COALESCE($5, pending_points_reported) WHERE id = $1`,
      [s.id, status, finishedAt, reasonText.slice(0, 300), body.pendingPoints ?? null]
    );
    await audit(req, { action: status === 'FINISHED' ? 'TRACKING_FINISHED' : 'TRACKING_INTERRUPTED', targetType: 'session', targetId: s.id,
      scope: await storeLabel(s.store_id, db), details: reasonText }, db);
  });
  scheduleCoverage(s.campaign_id);
  const stale = await getInt('TRACKING_STALE_MINUTES');
  const { rows } = await pool.query(`${SESSION_SQL} WHERE t.id = $1`, [s.id]);
  const dto = sessionDto(rows[0], stale);
  broadcast('tracking', { type: 'session', session: dto }, s.store_id, (u) => can(u.role, 'tracking.view') || u.id === s.user_id);
  emitWebhook('tracking.session.finished', { sessionId: s.id, campaignId: s.campaign_id, storeId: s.store_id, status, finishedAt });
  return res.json(dto);
}));

// ---------------------------------------------------------------- consultas
function sessionFilters(user: SessionUser, q: any, params: unknown[]) {
  let where = scopeSql(user, 't.store_id', params);
  if (!can(user.role, 'tracking.view')) { params.push(user.id); where += ` AND t.user_id = $${params.length}`; }
  if (q.storeId) { assertStoreAccess(user, String(q.storeId)); params.push(String(q.storeId)); where += ` AND t.store_id = $${params.length}`; }
  if (q.storeIds) {
    const ids = String(q.storeIds).split(',').filter(Boolean);
    ids.forEach((id) => assertStoreAccess(user, id));
    params.push(ids); where += ` AND t.store_id = ANY($${params.length}::text[])`;
  }
  if (q.campaignId) { params.push(String(q.campaignId)); where += ` AND t.campaign_id = $${params.length}`; }
  if (q.userId) { params.push(String(q.userId)); where += ` AND t.user_id = $${params.length}`; }
  if (q.from && /^\d{4}-\d{2}-\d{2}/.test(String(q.from))) { params.push(String(q.from)); where += ` AND t.started_at >= $${params.length}::date`; }
  if (q.to && /^\d{4}-\d{2}-\d{2}/.test(String(q.to))) { params.push(String(q.to)); where += ` AND t.started_at < ($${params.length}::date + 1)`; }
  if (q.status && ['IN_PROGRESS', 'FINISHED', 'INTERRUPTED', 'WAITING'].includes(String(q.status))) {
    params.push(String(q.status)); where += ` AND t.status = $${params.length}`;
  }
  return where;
}

trackingRouter.get('/sessions', h(async (req, res) => {
  const user = userOf(req);
  const params: unknown[] = [];
  const where = sessionFilters(user, req.query, params);
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? ''), 10) || 200, 1), 1000);
  const { rows } = await pool.query(`${SESSION_SQL} WHERE ${where} ORDER BY t.started_at DESC NULLS LAST LIMIT ${limit}`, params);
  const stale = await getInt('TRACKING_STALE_MINUTES');
  return res.json(rows.map((r) => sessionDto(r, stale)));
}));

trackingRouter.get('/sessions/:id', h(async (req, res) => {
  const user = userOf(req);
  const r = await loadSession(user, req.params.id);
  const params = await trackParams();
  const track = await sessionTrack(r.id, params);
  const { rows: rejectedRows } = await pool.query(
    `SELECT reject_reason, COUNT(*)::int AS n FROM gps_points WHERE session_id = $1 AND NOT accepted GROUP BY reject_reason`, [r.id]
  );
  const { rows: acc } = await pool.query(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY accuracy_m) AS median, MIN(captured_at) AS first, MAX(captured_at) AS last,
            AVG(EXTRACT(EPOCH FROM (received_at - captured_at))) AS avg_delay_s
       FROM gps_points WHERE session_id = $1 AND accepted`, [r.id]
  );
  if (r.user_id !== user.id) {
    // Percurso de outra pessoa é dado pessoal (LGPD): a consulta fica registrada
    await audit(req, { action: 'SESSION_VIEWED', targetType: 'session', targetId: r.id, targetName: `${r.user_name} — ${r.campaign_name}`, scope: `${r.store_name} (${r.store_code})` });
  }
  return res.json({
    ...sessionDto(r, await getInt('TRACKING_STALE_MINUTES')),
    track: {
      segments: track.segments,
      distanceM: Math.round(track.distanceM),
      validPoints: track.validPoints,
      totalPoints: track.totalPoints,
      gaps: track.gaps,
      discarded: track.discarded,
      rejectedByReason: rejectedRows.map((x) => ({ reason: x.reject_reason, count: x.n })),
      medianAccuracyM: acc[0]?.median === null || acc[0]?.median === undefined ? null : Math.round(acc[0].median),
      firstPointAt: acc[0]?.first ?? null,
      lastPointAt: acc[0]?.last ?? null,
      avgSyncDelaySeconds: acc[0]?.avg_delay_s === null || acc[0]?.avg_delay_s === undefined ? null : Math.round(Number(acc[0].avg_delay_s)),
      params,
    },
  });
}));

/** Pontos brutos de uma sessão (para auditoria/reprocessamento), em CSV */
trackingRouter.get('/sessions/:id/points.csv', requireCapability('tracking.view'), h(async (req, res) => {
  const user = userOf(req);
  const r = await loadSession(user, req.params.id);
  const { rows } = await pool.query(
    `SELECT client_point_id, lat, lng, accuracy_m, speed_mps, captured_at, received_at, accepted, reject_reason FROM gps_points WHERE session_id = $1 ORDER BY captured_at, id`,
    [r.id]
  );
  await audit(req, { action: 'REPORT_EXPORTED', targetType: 'session', targetId: r.id, targetName: `Pontos GPS — ${r.user_name}`, scope: `${r.store_name} (${r.store_code})`, details: `${rows.length} ponto(s).` });
  sendCsv(res, `pontos-${r.id}.csv`, ['id_ponto', 'latitude', 'longitude', 'precisao_m', 'velocidade_m_s', 'capturado_em', 'recebido_em', 'aceito', 'motivo_recusa'],
    rows.map((p) => [p.client_point_id, p.lat, p.lng, p.accuracy_m, p.speed_mps, new Date(p.captured_at).toISOString(), new Date(p.received_at).toISOString(), p.accepted ? 'sim' : 'não', p.reject_reason]));
}));

/** Rastreamentos em andamento (mapa ao vivo) */
trackingRouter.get('/live', h(async (req, res) => {
  const user = userOf(req);
  const params: unknown[] = [];
  const where = sessionFilters(user, { ...req.query, status: 'IN_PROGRESS' }, params);
  const { rows } = await pool.query(`${SESSION_SQL} WHERE ${where} ORDER BY t.started_at DESC LIMIT 500`, params);
  const stale = await getInt('TRACKING_STALE_MINUTES');
  return res.json(rows.map((r) => sessionDto(r, stale)));
}));

/** Percursos para a camada "Percursos realizados" do mapa (trechos contínuos, sem ligar falhas de sinal) */
const routeViewAudit = new Map<string, number>();
trackingRouter.get('/routes', requireCapability('tracking.view'), h(async (req, res) => {
  const user = userOf(req);
  const params: unknown[] = [];
  const where = sessionFilters(user, req.query, params);
  const { rows } = await pool.query(`${SESSION_SQL} WHERE ${where} ORDER BY t.started_at DESC LIMIT 200`, params);
  const tp = await trackParams();
  const ids = rows.map((r) => r.id);
  const { rows: pts } = ids.length
    ? await pool.query(`SELECT session_id, lat, lng, accuracy_m, captured_at, accepted FROM gps_points WHERE session_id = ANY($1::text[]) ORDER BY session_id, captured_at, id`, [ids])
    : { rows: [] as any[] };
  const bySession = new Map<string, any[]>();
  for (const p of pts) (bySession.get(p.session_id) ?? bySession.set(p.session_id, []).get(p.session_id)!).push(p);
  const stale = await getInt('TRACKING_STALE_MINUTES');
  const features = rows.flatMap((r) => {
    const t = buildTrack(bySession.get(r.id) ?? [], tp);
    if (!t.segments.length) return [];
    return [{
      type: 'Feature',
      geometry: { type: 'MultiLineString', coordinates: t.segments },
      properties: {
        sessionId: r.id, campaignId: r.campaign_id, campaignName: r.campaign_name, storeId: r.store_id, storeName: r.store_name,
        userName: r.user_name, startedAt: r.started_at, finishedAt: r.finished_at, state: sessionState(r, stale),
        distanceM: Math.round(t.distanceM),
      },
    }];
  });
  // Consulta de percursos (dados de localização de pessoas) registrada no máximo a cada 30 min por pessoa
  const last = routeViewAudit.get(user.id) ?? 0;
  if (Date.now() - last > 30 * 60_000 && features.length) {
    routeViewAudit.set(user.id, Date.now());
    await audit(req, { action: 'SESSION_VIEWED', targetType: 'routes', targetName: 'Camada de percursos do mapa', details: `${features.length} percurso(s) exibidos.` });
  }
  return res.json({ type: 'FeatureCollection', features, truncated: rows.length === 200 });
}));

/** Sessões esquecidas abertas: depois de 12 h sem nenhum ponto, ficam como "Interrompida" */
export function startStaleSessionJob() {
  const run = async () => {
    try {
      const { rows } = await pool.query(
        `UPDATE tracking_sessions SET status = 'INTERRUPTED', finished_at = COALESCE(last_point_captured_at, started_at),
            finish_reason = 'Interrompida automaticamente: mais de 12 horas sem comunicação'
          WHERE status = 'IN_PROGRESS' AND COALESCE(last_point_received_at, started_at) < NOW() - INTERVAL '12 hours'
          RETURNING id, campaign_id`
      );
      for (const r of rows) scheduleCoverage(r.campaign_id);
    } catch (err) {
      console.error('[RASTREAMENTO] Falha ao encerrar sessões paradas:', (err as Error).message);
    }
  };
  setTimeout(run, 30_000).unref?.();
  setInterval(run, 15 * 60_000).unref?.();
}
