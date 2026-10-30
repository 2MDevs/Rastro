import { Router } from 'express';
import crypto from 'crypto';
import net from 'net';
import { z } from 'zod';
import { pool, tx } from '../db';
import { h, HttpError, parse } from '../http';
import { audit } from '../audit';
import { requireAuth, requireCapability, userOf, newId, sha256, API_KEY_PREFIX, API_SCOPES } from '../auth/core';
import { encrypt, encryptionKey } from '../settings';
import { WEBHOOK_EVENTS, deliver } from '../services/webhooks';

/** Chaves de API e webhooks (tela Sistema › API & Webhooks). Esta área nunca aceita chave de API. */
export const apiKeysRouter = Router();
apiKeysRouter.use(requireAuth(), requireCapability('apikeys.manage'));

apiKeysRouter.get('/keys', h(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT k.id, k.name, k.key_prefix, k.scopes, k.created_at, k.last_used_at, k.last_used_ip, k.revoked_at, u.name AS created_by_name
       FROM api_keys k JOIN users u ON u.id = k.created_by ORDER BY k.revoked_at NULLS FIRST, k.created_at DESC`
  );
  return res.json({
    keys: rows.map((r) => ({
      id: r.id, name: r.name, preview: `${r.key_prefix}…`, scopes: r.scopes, createdBy: r.created_by_name, createdAt: r.created_at,
      lastUsedAt: r.last_used_at, lastUsedIp: r.last_used_ip, revoked: Boolean(r.revoked_at), revokedAt: r.revoked_at,
    })),
    scopes: Object.entries(API_SCOPES).map(([value, label]) => ({ value, label })),
  });
}));

apiKeysRouter.post('/keys', h(async (req, res) => {
  const user = userOf(req);
  const body = parse(z.object({
    name: z.string().trim().min(3, 'Dê um nome que identifique o sistema que vai usar a chave.').max(80),
    scopes: z.array(z.enum(Object.keys(API_SCOPES) as [string, ...string[]])).min(1, 'Escolha pelo menos uma permissão.'),
  }), req.body);
  const secret = API_KEY_PREFIX + crypto.randomBytes(32).toString('hex');
  const id = newId('key');
  await tx(async (db) => {
    await db.query(
      `INSERT INTO api_keys (id, name, key_prefix, key_hash, scopes, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, body.name, secret.slice(0, API_KEY_PREFIX.length + 6), sha256(secret), [...new Set(body.scopes)], user.id]
    );
    await audit(req, { action: 'API_KEY_CREATED', targetType: 'api_key', targetId: id, targetName: body.name, details: `Permissões: ${body.scopes.join(', ')}.` }, db);
  });
  // A chave completa aparece uma única vez; o banco guarda só o hash
  return res.status(201).json({ id, key: secret });
}));

apiKeysRouter.post('/keys/:id/revoke', h(async (req, res) => {
  const { rows } = await pool.query('UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL RETURNING name', [req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Chave não encontrada ou já revogada.');
  await audit(req, { action: 'API_KEY_REVOKED', targetType: 'api_key', targetId: req.params.id, targetName: rows[0].name });
  return res.json({ ok: true });
}));

// ---------------------------------------------------------------- webhooks
function isPrivateHost(host: string) {
  const h0 = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h0 === 'localhost' || h0.endsWith('.localhost') || h0.endsWith('.internal') || h0.endsWith('.local')) return true;
  if (net.isIP(h0)) {
    return /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h0) || h0 === '::1' || h0.startsWith('fc') || h0.startsWith('fd') || h0.startsWith('fe80');
  }
  return false;
}

const WebhookInput = z.object({
  name: z.string().trim().min(3).max(80),
  url: z.string().trim().url('Endereço inválido.').max(500),
  events: z.array(z.enum(Object.keys(WEBHOOK_EVENTS) as [string, ...string[]])).min(1, 'Escolha pelo menos um evento.'),
  active: z.boolean().optional(),
});

function checkUrl(url: string) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new HttpError(400, 'O webhook precisa usar um endereço HTTPS.');
  if (isPrivateHost(u.hostname)) throw new HttpError(400, 'O webhook não pode apontar para endereços internos.');
  if (u.username || u.password) throw new HttpError(400, 'Não coloque usuário ou senha no endereço do webhook.');
}

apiKeysRouter.get('/webhooks', h(async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM webhooks ORDER BY created_at DESC');
  return res.json({
    webhooks: rows.map((r) => ({ id: r.id, name: r.name, url: r.url, events: r.events, active: r.active, createdAt: r.created_at,
      lastDeliveryAt: r.last_delivery_at, lastStatus: r.last_status, lastError: r.last_error })),
    events: Object.entries(WEBHOOK_EVENTS).map(([value, label]) => ({ value, label })),
    encryptionReady: Boolean(encryptionKey()),
  });
}));

apiKeysRouter.post('/webhooks', h(async (req, res) => {
  const user = userOf(req);
  const body = parse(WebhookInput, req.body);
  checkUrl(body.url);
  if (!encryptionKey()) throw new HttpError(503, 'Configure a SETTINGS_ENCRYPTION_KEY no servidor antes de criar webhooks.');
  const secret = 'whsec_' + crypto.randomBytes(24).toString('hex');
  const id = newId('whk');
  await tx(async (db) => {
    await db.query(
      `INSERT INTO webhooks (id, name, url, events, secret_encrypted, active, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, body.name, body.url, [...new Set(body.events)], encrypt(secret), body.active ?? true, user.id]
    );
    await audit(req, { action: 'WEBHOOK_CREATED', targetType: 'webhook', targetId: id, targetName: body.name, details: `${new URL(body.url).host} · ${body.events.join(', ')}` }, db);
  });
  return res.status(201).json({ id, secret });
}));

apiKeysRouter.patch('/webhooks/:id', h(async (req, res) => {
  const body = parse(WebhookInput.partial(), req.body);
  if (body.url) checkUrl(body.url);
  const { rows } = await pool.query(
    `UPDATE webhooks SET name = COALESCE($2, name), url = COALESCE($3, url), events = COALESCE($4, events), active = COALESCE($5, active) WHERE id = $1 RETURNING name`,
    [req.params.id, body.name ?? null, body.url ?? null, body.events ?? null, body.active ?? null]
  );
  if (!rows[0]) throw new HttpError(404, 'Webhook não encontrado.');
  await audit(req, { action: 'WEBHOOK_UPDATED', targetType: 'webhook', targetId: req.params.id, targetName: rows[0].name });
  return res.json({ ok: true });
}));

apiKeysRouter.delete('/webhooks/:id', h(async (req, res) => {
  const { rows } = await pool.query('DELETE FROM webhooks WHERE id = $1 RETURNING name', [req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Webhook não encontrado.');
  await audit(req, { action: 'WEBHOOK_DELETED', targetType: 'webhook', targetId: req.params.id, targetName: rows[0].name });
  return res.json({ ok: true });
}));

apiKeysRouter.post('/webhooks/:id/test', h(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM webhooks WHERE id = $1', [req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Webhook não encontrado.');
  const result = await deliver(rows[0], 'webhook.test', { message: 'Teste de envio do RASTRO.' });
  await audit(req, { action: 'WEBHOOK_TESTED', result: result.error ? 'FAILURE' : 'SUCCESS', targetType: 'webhook', targetId: rows[0].id, targetName: rows[0].name,
    details: result.error ?? `Resposta ${result.status}.` });
  return res.json(result);
}));
