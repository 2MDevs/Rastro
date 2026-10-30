import crypto from 'crypto';
import type { Request } from 'express';
import { pool, Queryable } from './db';
import { clientIp, deviceLabel } from './http';
import type { SessionUser } from './access';
import { ROLE_LABEL } from './access';

/**
 * Auditoria imutável e encadeada.
 * Cada registro guarda o hash do anterior; alterar ou apagar qualquer registro quebra a corrente.
 * O banco também recusa UPDATE/DELETE/TRUNCATE nesta tabela (gatilho na migração 001).
 */

export type AuditResult = 'SUCCESS' | 'DENIED' | 'BLOCKED' | 'FAILURE';

export interface AuditEntry {
  action: string;
  result?: AuditResult;
  targetType?: string;
  targetId?: string | null;
  targetName?: string | null;
  details?: string;
  scope?: string; // loja ou escopo relacionado
}

export interface AuditActor {
  id: string | null;
  name: string;
  role: string;
}

const GENESIS = '0'.repeat(64);

export function auditHash(prev: string, r: Record<string, unknown>): string {
  const canonical = JSON.stringify([
    r.id, r.occurred_at, r.user_id ?? null, r.user_name, r.role, r.scope, r.action,
    r.target_type ?? null, r.target_id ?? null, r.target_name ?? null, r.details, r.result, r.ip, r.device,
  ]);
  return crypto.createHash('sha256').update(prev + '|' + canonical).digest('hex');
}

export async function writeAuditRaw(
  actor: AuditActor,
  entry: AuditEntry,
  ctx: { ip: string; device: string },
  db?: Queryable
): Promise<void> {
  const run = async (client: Queryable) => {
    // Serializa as gravações para a corrente de hashes não "bifurcar"
    await client.query('SELECT pg_advisory_xact_lock(727275)');
    const { rows } = await client.query('SELECT hash FROM audit_logs ORDER BY seq DESC LIMIT 1');
    const prev = rows[0]?.hash ?? GENESIS;
    const rec = {
      id: 'aud_' + crypto.randomBytes(12).toString('hex'),
      occurred_at: new Date().toISOString(),
      user_id: actor.id,
      user_name: actor.name,
      role: ROLE_LABEL[actor.role as keyof typeof ROLE_LABEL] ?? actor.role,
      scope: entry.scope ?? 'Geral',
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      target_name: entry.targetName ?? null,
      details: (entry.details ?? '').slice(0, 2000),
      result: entry.result ?? 'SUCCESS',
      ip: ctx.ip,
      device: ctx.device.slice(0, 200),
    };
    const hash = auditHash(prev, rec);
    await client.query(
      `INSERT INTO audit_logs (id, occurred_at, user_id, user_name, role, scope, action, target_type, target_id,
         target_name, details, result, ip, device, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [rec.id, rec.occurred_at, rec.user_id, rec.user_name, rec.role, rec.scope, rec.action, rec.target_type,
        rec.target_id, rec.target_name, rec.details, rec.result, rec.ip, rec.device, prev, hash]
    );
  };

  if (db && 'release' in db) return run(db); // já dentro de uma transação
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await run(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Grava a auditoria de uma requisição autenticada (inclui "Nome (API: chave)" quando veio de chave de API). */
export async function audit(req: Request, entry: AuditEntry, db?: Queryable) {
  const user = (req as any).user as SessionUser | undefined;
  const actor: AuditActor = user
    ? { id: user.id, name: user.auditName, role: user.role }
    : { id: null, name: 'Anônimo', role: 'ANONYMOUS' };
  try {
    await writeAuditRaw(actor, entry, { ip: clientIp(req), device: deviceLabel(req) }, db);
  } catch (err) {
    if (db) throw err; // dentro de transação: a ação não acontece sem a auditoria
    console.error('[AUDITORIA] Falha ao gravar registro:', (err as Error).message);
  }
}

/** Confere a corrente inteira (ou um trecho) e aponta o primeiro registro adulterado. */
export async function verifyAuditChain(): Promise<{ ok: boolean; checked: number; brokenAt?: { seq: number; id: string } }> {
  const client = await pool.connect();
  try {
    let prev = GENESIS;
    let checked = 0;
    let lastSeq = 0;
    for (;;) {
      const { rows } = await client.query(
        `SELECT seq, id, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at,
                user_id, user_name, role, scope, action, target_type, target_id, target_name, details, result, ip, device, prev_hash, hash
           FROM audit_logs WHERE seq > $1 ORDER BY seq LIMIT 2000`,
        [lastSeq]
      );
      if (!rows.length) break;
      for (const r of rows) {
        if (r.prev_hash !== prev || auditHash(prev, r) !== r.hash) {
          return { ok: false, checked, brokenAt: { seq: Number(r.seq), id: r.id } };
        }
        prev = r.hash;
        checked++;
        lastSeq = Number(r.seq);
      }
    }
    return { ok: true, checked };
  } finally {
    client.release();
  }
}

/** Nomes das ações em português para a tela de Auditoria */
export const ACTION_LABEL: Record<string, string> = {
  LOGIN: 'Login',
  LOGIN_FAILED: 'Falha de login',
  LOGIN_BLOCKED: 'Conta bloqueada por tentativas',
  LOGIN_INITIAL_SETUP: 'Login sem 2FA (configuração inicial)',
  TWO_FACTOR_SENT: '2FA: código enviado',
  TWO_FACTOR_VERIFIED: '2FA: código confirmado',
  TWO_FACTOR_FAILED: '2FA: código incorreto',
  LOGOUT: 'Saída',
  SESSION_LOCKED: 'Tela bloqueada por inatividade',
  SESSION_UNLOCKED: 'Tela desbloqueada',
  SESSION_UNLOCK_FAILED: 'Desbloqueio recusado',
  SESSION_ENDED: 'Sessão encerrada',
  PASSWORD_CHANGED: 'Senha alterada',
  PASSWORD_RESET_REQUESTED: 'Redefinição de senha solicitada',
  PASSWORD_RESET: 'Senha redefinida',
  PIN_CHANGED: 'PIN alterado',
  PIN_REMOVED: 'PIN removido',
  REAUTH: 'Senha confirmada (área restrita)',
  REAUTH_FAILED: 'Senha incorreta (área restrita)',
  USER_CREATED: 'Usuário criado',
  USER_UPDATED: 'Usuário alterado',
  USER_BLOCKED: 'Usuário bloqueado',
  USER_UNBLOCKED: 'Usuário desbloqueado',
  USER_INVITE_SENT: 'Acesso enviado por e-mail',
  USER_STORES_CHANGED: 'Lojas do usuário alteradas',
  STORE_CREATED: 'Loja criada',
  STORE_UPDATED: 'Loja alterada',
  STORE_LOCATED: 'Localização da loja registrada (GPS)',
  AREA_CREATED: 'Território criado',
  AREA_UPDATED: 'Território alterado',
  AREA_ARCHIVED: 'Território arquivado',
  POI_CREATED: 'Ponto de interesse criado',
  POI_UPDATED: 'Ponto de interesse alterado',
  POI_DELETED: 'Ponto de interesse removido',
  CAMPAIGN_CREATED: 'Campanha criada',
  CAMPAIGN_UPDATED: 'Campanha alterada',
  CAMPAIGN_STATUS: 'Situação da campanha alterada',
  CAMPAIGN_ASSIGNMENTS: 'Responsáveis da campanha alterados',
  STREETS_FETCHED: 'Ruas buscadas na rede viária',
  STREETS_PLANNED: 'Ruas planejadas alteradas',
  COVERAGE_COMPUTED: 'Cobertura calculada',
  TRACKING_STARTED: 'Rastreamento iniciado',
  TRACKING_FINISHED: 'Rastreamento encerrado',
  TRACKING_INTERRUPTED: 'Rastreamento interrompido',
  TRACKING_DENIED: 'Envio de GPS recusado',
  SESSION_VIEWED: 'Percurso consultado',
  REPORT_EXPORTED: 'Relatório exportado',
  DEVICE_TRUSTED: 'Dispositivo confiável registrado',
  DEVICE_BLOCKED: 'Dispositivo bloqueado',
  DEVICE_REVOKED: 'Confiança do dispositivo revogada',
  DEVICE_APPROVED: 'Dispositivo aprovado',
  DEVICE_REMOVED: 'Dispositivo removido',
  TRACKER_REGISTERED: 'Aparelho de rastreamento registrado',
  TRACKER_BLOCKED: 'Aparelho de rastreamento bloqueado',
  TRACKER_REVOKED: 'Aparelho de rastreamento revogado',
  TRACKER_ACTIVATED: 'Aparelho de rastreamento reativado',
  API_KEY_CREATED: 'Chave de API criada',
  API_KEY_REVOKED: 'Chave de API revogada',
  API_KEY_DENIED: 'Chave de API recusada',
  WEBHOOK_CREATED: 'Webhook criado',
  WEBHOOK_UPDATED: 'Webhook alterado',
  WEBHOOK_DELETED: 'Webhook removido',
  WEBHOOK_TESTED: 'Webhook testado',
  SETTINGS_UPDATED: 'Configurações alteradas',
  SMTP_TESTED: 'E-mail de teste enviado',
  SYSTEM_UPDATE_REQUESTED: 'Atualização do sistema solicitada',
  SYSTEM_UPDATE_DENIED: 'Atualização do sistema recusada',
  ARTIFACT_VIEWED: 'Artefato visualizado',
  ARTIFACT_DOWNLOADED: 'Artefato baixado',
  ARTIFACT_REPLACED: 'Artefato substituído',
  AUDIT_EXPORTED: 'Auditoria exportada',
  AUDIT_VERIFIED: 'Integridade da auditoria conferida',
  ACCESS_DENIED: 'Acesso negado',
};
