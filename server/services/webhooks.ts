import crypto from 'crypto';
import { pool } from '../db';
import { decrypt } from '../settings';

/**
 * Webhooks de saída: avisam outro sistema quando algo acontece no RASTRO.
 * Só para endereços HTTPS. Cada envio é assinado com o segredo do webhook:
 *   X-Rastro-Timestamp: segundos desde 1970
 *   X-Rastro-Signature: sha256=HMAC_SHA256(segredo, "<timestamp>.<corpo>")
 */

export const WEBHOOK_EVENTS: Record<string, string> = {
  'tracking.session.started': 'Rastreamento iniciado',
  'tracking.session.finished': 'Rastreamento encerrado ou interrompido',
  'campaign.status_changed': 'Situação de campanha alterada',
  'coverage.computed': 'Cobertura calculada',
};

export function signPayload(secret: string, timestamp: number, body: string) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export async function deliver(hook: { id: string; url: string; secret_encrypted: string }, event: string, data: unknown) {
  const body = JSON.stringify({ id: crypto.randomUUID(), event, createdAt: new Date().toISOString(), data });
  const ts = Math.floor(Date.now() / 1000);
  let status = 'ERRO', error: string | null = null;
  try {
    if (!hook.url.startsWith('https://')) throw new Error('O endereço precisa usar HTTPS.');
    const secret = decrypt(hook.secret_encrypted);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const resp = await fetch(hook.url, {
        method: 'POST',
        redirect: 'error',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'RASTRO-Webhook/1.0',
          'X-Rastro-Event': event,
          'X-Rastro-Timestamp': String(ts),
          'X-Rastro-Signature': signPayload(secret, ts, body),
        },
        body,
      });
      status = String(resp.status);
      if (!resp.ok) error = `O destino respondeu ${resp.status}.`;
    } finally {
      clearTimeout(timer);
    }
  } catch (err: any) {
    error = err?.name === 'AbortError' ? 'O destino não respondeu em 10 segundos.' : String(err?.message || 'Falha ao enviar.').slice(0, 300);
  }
  await pool.query('UPDATE webhooks SET last_delivery_at = NOW(), last_status = $2, last_error = $3 WHERE id = $1', [hook.id, status, error]).catch(() => {});
  return { status, error };
}

/** Dispara em segundo plano para todos os webhooks ativos inscritos no evento */
export function emitWebhook(event: string, data: unknown) {
  if (process.env.NODE_ENV === 'test' && process.env.WEBHOOKS_IN_TESTS !== 'true') return;
  pool.query('SELECT id, url, secret_encrypted FROM webhooks WHERE active AND $1 = ANY(events)', [event])
    .then(({ rows }) => Promise.all(rows.map((h) => deliver(h, event, data))))
    .catch((err) => console.error('[WEBHOOK]', err.message));
}
