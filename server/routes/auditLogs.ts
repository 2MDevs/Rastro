import { Router } from 'express';
import { pool } from '../db';
import { h, HttpError, sendCsv } from '../http';
import { audit, verifyAuditChain, ACTION_LABEL } from '../audit';
import { requireAuth, requireCapability } from '../auth/core';

export const auditRouter = Router();
auditRouter.use(requireAuth(), requireCapability('audit.view'));

const RESULT_LABEL: Record<string, string> = { SUCCESS: 'Sucesso', DENIED: 'Negado', BLOCKED: 'Bloqueado', FAILURE: 'Falha' };

function where(q: any, params: unknown[]) {
  const parts: string[] = ['TRUE'];
  const add = (sql: string, v: unknown) => { params.push(v); parts.push(sql.replace('?', `$${params.length}`)); };
  if (q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from)) add(`occurred_at >= ?::date`, q.from);
  if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) add(`occurred_at < (?::date + 1)`, q.to);
  if (q.userId) add('user_id = ?', String(q.userId));
  if (q.action) add('action = ANY(?::text[])', String(q.action).split(',').slice(0, 30));
  if (q.result && RESULT_LABEL[q.result]) add('result = ?', q.result);
  if (q.scope) add('scope ILIKE ?', `%${String(q.scope).slice(0, 80)}%`);
  if (q.q) {
    params.push(`%${String(q.q).slice(0, 80)}%`);
    const n = `$${params.length}`;
    parts.push(`(user_name ILIKE ${n} OR target_name ILIKE ${n} OR details ILIKE ${n} OR ip ILIKE ${n})`);
  }
  return parts.join(' AND ');
}

const dto = (r: any) => ({
  id: r.id, seq: Number(r.seq), at: r.occurred_at, userId: r.user_id, userName: r.user_name, role: r.role, scope: r.scope,
  action: r.action, actionLabel: ACTION_LABEL[r.action] ?? r.action, targetType: r.target_type, targetName: r.target_name,
  details: r.details, result: r.result, resultLabel: RESULT_LABEL[r.result] ?? r.result, ip: r.ip, device: r.device, hash: r.hash,
});

auditRouter.get('/', h(async (req, res) => {
  const params: unknown[] = [];
  const w = where(req.query, params);
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? ''), 10) || 100, 1), 500);
  const before = parseInt(String(req.query.before ?? ''), 10) || null;
  const sql = `SELECT * FROM audit_logs WHERE ${w}${before ? ` AND seq < ${before}` : ''} ORDER BY seq DESC LIMIT ${limit + 1}`;
  const { rows } = await pool.query(sql, params);
  const { rows: people } = await pool.query(`SELECT DISTINCT user_id, user_name FROM audit_logs WHERE user_id IS NOT NULL ORDER BY user_name LIMIT 500`);
  return res.json({
    entries: rows.slice(0, limit).map(dto),
    nextBefore: rows.length > limit ? Number(rows[limit - 1].seq) : null,
    actions: Object.entries(ACTION_LABEL).map(([value, label]) => ({ value, label })),
    people: people.map((p) => ({ id: p.user_id, name: p.user_name })),
  });
}));

auditRouter.get('/export.csv', h(async (req, res) => {
  const params: unknown[] = [];
  const w = where(req.query, params);
  const { rows } = await pool.query(`SELECT * FROM audit_logs WHERE ${w} ORDER BY seq DESC LIMIT 50000`, params);
  await audit(req, { action: 'AUDIT_EXPORTED', targetType: 'audit', details: `${rows.length} registro(s) exportados.` });
  sendCsv(res, 'rastro-auditoria.csv',
    ['sequencia', 'data_hora', 'pessoa', 'perfil', 'loja_escopo', 'acao', 'item', 'detalhes', 'resultado', 'ip', 'dispositivo', 'hash', 'hash_anterior'],
    rows.map((r) => [r.seq, new Date(r.occurred_at).toISOString(), r.user_name, r.role, r.scope, ACTION_LABEL[r.action] ?? r.action, r.target_name, r.details,
      RESULT_LABEL[r.result] ?? r.result, r.ip, r.device, r.hash, r.prev_hash]));
}));

auditRouter.post('/verify', h(async (req, res) => {
  const result = await verifyAuditChain();
  await audit(req, { action: 'AUDIT_VERIFIED', result: result.ok ? 'SUCCESS' : 'FAILURE',
    details: result.ok ? `${result.checked} registro(s) conferidos: corrente íntegra.` : `Corrente quebrada no registro ${result.brokenAt?.seq}.` });
  if (!result.ok && !result.brokenAt) throw new HttpError(500, 'Falha ao conferir.');
  return res.json(result);
}));
