import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { pool, Queryable } from '../db';
import { getInt } from '../settings';
import { HttpError, clientIp, parseUserAgent } from '../http';
import { loadSessionUser, SessionUser, can, Capability } from '../access';

export const SESSION_COOKIE = 'rastro_session';
export const DEVICE_COOKIE = 'rastro_device';
export const TRUST_DAYS = 30;
export const REAUTH_MINUTES = 10;

export const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
export const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;

/** Hash de códigos curtos (2FA): HMAC com a chave do servidor, para não ser quebrável só com o banco */
export function codeHash(code: string): string {
  const key = process.env.SETTINGS_ENCRYPTION_KEY || 'rastro-sem-chave';
  return crypto.createHmac('sha256', key).update(code).digest('hex');
}

export function safeEqualHex(a: string | null | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function validatePassword(pw: unknown): string {
  const s = typeof pw === 'string' ? pw : '';
  if (s.length < 10 || !/[A-Za-z]/.test(s) || !/\d/.test(s)) {
    throw new HttpError(400, 'A senha precisa ter pelo menos 10 caracteres, com letras e números.');
  }
  if (s.length > 200) throw new HttpError(400, 'A senha é longa demais.');
  return s;
}

const isHttps = () => (process.env.APP_URL || '').startsWith('https://') || process.env.NODE_ENV === 'production';

function cookieOpts(maxAgeMs: number) {
  return { httpOnly: true, secure: isHttps(), sameSite: 'lax' as const, path: '/', maxAge: maxAgeMs };
}

// ---------------------------------------------------------------- limites por IP (login, 2FA, senha)
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT || 10),
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  message: { error: 'Muitas tentativas a partir deste endereço. Aguarde 15 minutos e tente novamente.' },
});

// ---------------------------------------------------------------- sessão
export async function createSession(userId: string, deviceId: string | null, req: Request, res: Response, db: Queryable = pool) {
  const token = randomToken();
  const ttl = await getInt('SESSION_TTL_HOURS');
  const id = newId('ses');
  await db.query(
    `INSERT INTO sessions (id, user_id, device_id, token_hash, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW() + make_interval(hours => $7))`,
    [id, userId, deviceId, sha256(token), clientIp(req), String(req.headers['user-agent'] || '').slice(0, 400), ttl]
  );
  await db.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [userId]);
  res.cookie(SESSION_COOKIE, token, cookieOpts(ttl * 3600 * 1000));
  return id;
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export async function revokeUserSessions(userId: string, exceptSessionId?: string, db: Queryable = pool) {
  await db.query(
    `UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL AND ($2::text IS NULL OR id <> $2)`,
    [userId, exceptSessionId ?? null]
  );
}

// ---------------------------------------------------------------- dispositivos de acesso
export async function registerAuthDevice(
  userId: string, trusted: boolean, deviceName: string | undefined, req: Request, res: Response, db: Queryable = pool
): Promise<string> {
  const ua = parseUserAgent(req.headers['user-agent']);
  const token = randomToken();
  const existingToken = req.cookies?.[DEVICE_COOKIE];
  // Reaproveita o registro se este navegador já era conhecido para esta pessoa
  if (existingToken) {
    const { rows } = await db.query(
      `SELECT id, status FROM auth_devices WHERE token_hash = $1 AND user_id = $2`,
      [sha256(existingToken), userId]
    );
    if (rows[0] && rows[0].status !== 'BLOCKED') {
      await db.query(
        `UPDATE auth_devices SET status = $2, trusted_until = CASE WHEN $3 THEN NOW() + make_interval(days => $4) ELSE NULL END,
           last_seen_at = NOW(), ip = $5, token_hash = $6, name = COALESCE(NULLIF($7, ''), name)
         WHERE id = $1`,
        [rows[0].id, trusted ? 'TRUSTED' : 'PENDING', trusted, TRUST_DAYS, clientIp(req), sha256(token), (deviceName || '').slice(0, 80)]
      );
      res.cookie(DEVICE_COOKIE, token, cookieOpts(365 * 24 * 3600 * 1000));
      return rows[0].id;
    }
  }
  const id = newId('dev');
  await db.query(
    `INSERT INTO auth_devices (id, user_id, name, os, browser, device_type, ip, token_hash, status, trusted_until)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $10 THEN NOW() + make_interval(days => $11) ELSE NULL END)`,
    [id, userId, (deviceName || '').trim().slice(0, 80) || ua.label, ua.os, ua.browser, ua.deviceType, clientIp(req),
      sha256(token), trusted ? 'TRUSTED' : 'PENDING', trusted, TRUST_DAYS]
  );
  res.cookie(DEVICE_COOKIE, token, cookieOpts(365 * 24 * 3600 * 1000));
  return id;
}

/** Dispositivo deste navegador para a pessoa (pelo cookie), com a situação atual */
export async function currentAuthDevice(req: Request, userId: string) {
  const token = req.cookies?.[DEVICE_COOKIE];
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT id, status, trusted_until, (status = 'TRUSTED' AND trusted_until > NOW()) AS trusted_now
       FROM auth_devices WHERE token_hash = $1 AND user_id = $2`,
    [sha256(token), userId]
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------- chaves de API
export const API_KEY_PREFIX = 'rst_live_';

export const API_SCOPES: Record<string, string> = {
  'stores:read': 'Ler lojas e territórios',
  'campaigns:read': 'Ler campanhas e ruas planejadas',
  'tracking:read': 'Ler percursos',
  'tracking:write': 'Enviar pontos de GPS (equipamentos e integrações)',
  'reports:read': 'Ler relatórios de cobertura',
};

async function authenticateApiKey(raw: string, req: Request): Promise<SessionUser> {
  if (!raw.startsWith(API_KEY_PREFIX) || raw.length !== API_KEY_PREFIX.length + 64) {
    throw new HttpError(401, 'Chave de API inválida.', 'API_KEY');
  }
  const { rows } = await pool.query(
    `SELECT k.id AS key_id, k.name AS key_name, k.scopes, k.revoked_at, u.*
       FROM api_keys k JOIN users u ON u.id = k.created_by WHERE k.key_hash = $1`,
    [sha256(raw)]
  );
  const row = rows[0];
  if (!row || row.revoked_at) throw new HttpError(401, 'Chave de API inválida ou revogada.', 'API_KEY');
  if (row.status !== 'ACTIVE') throw new HttpError(401, 'A pessoa que criou esta chave está bloqueada.', 'API_KEY');
  await pool.query('UPDATE api_keys SET last_used_at = NOW(), last_used_ip = $2 WHERE id = $1', [row.key_id, clientIp(req)]);
  const user = await loadSessionUser(row);
  user.auditName = `${user.name} (API: ${row.key_name})`;
  user.apiKey = { id: row.key_id, name: row.key_name, scopes: row.scopes };
  return user;
}

// ---------------------------------------------------------------- middleware
const LOCKED_ALLOWED = new Set(['/api/auth/unlock', '/api/auth/me', '/api/auth/logout', '/api/auth/security-policy', '/api/events']);
const MUST_CHANGE_ALLOWED = new Set(['/api/auth/change-password', '/api/auth/me', '/api/auth/logout', '/api/auth/security-policy']);

interface AuthOptions {
  /** Escopos de chave de API aceitos nesta rota. Sem isto, a rota só aceita sessão (nunca chave de API). */
  apiKeyScopes?: string[];
}

export function requireAuth(opts: AuthOptions = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''))?.[1]?.trim();
      const headerKey = String(req.headers['x-api-key'] || '').trim();
      const apiKey = headerKey || (bearer?.startsWith(API_KEY_PREFIX) ? bearer : '');
      if (apiKey) {
        if (!opts.apiKeyScopes?.length) {
          throw new HttpError(401, 'Esta área do sistema não aceita chave de API.', 'API_KEY_NOT_ALLOWED');
        }
        const user = await authenticateApiKey(apiKey, req);
        const granted = opts.apiKeyScopes.filter((s) => user.apiKey!.scopes.includes(s));
        if (!granted.length) {
          throw new HttpError(403, `Esta chave não tem o escopo necessário (${opts.apiKeyScopes.join(' ou ')}).`, 'API_KEY_SCOPE');
        }
        // Escopos ":read" só consultam; alterar dados exige um escopo ":write" desta rota
        if (!['GET', 'HEAD'].includes(req.method) && !granted.some((s) => s.endsWith(':write'))) {
          throw new HttpError(403, 'Esta chave de API só pode consultar dados.', 'API_KEY_SCOPE');
        }
        (req as any).user = user;
        return next();
      }

      const token = req.cookies?.[SESSION_COOKIE];
      if (!token) throw new HttpError(401, 'Faça login para continuar.', 'NO_SESSION');
      const { rows } = await pool.query(
        `SELECT s.id AS session_id, s.locked_at, s.reauth_at, s.device_id, d.status AS device_status, u.*
           FROM sessions s
           JOIN users u ON u.id = s.user_id
           LEFT JOIN auth_devices d ON d.id = s.device_id
          WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW()`,
        [sha256(token)]
      );
      const row = rows[0];
      if (!row) {
        clearSessionCookie(res);
        throw new HttpError(401, 'Sua sessão terminou. Entre novamente.', 'NO_SESSION');
      }
      if (row.status !== 'ACTIVE' || row.device_status === 'BLOCKED' || row.device_status === 'REVOKED') {
        await pool.query('UPDATE sessions SET revoked_at = NOW() WHERE id = $1', [row.session_id]);
        clearSessionCookie(res);
        throw new HttpError(401, 'Seu acesso foi encerrado pela administração.', 'NO_SESSION');
      }

      // Renova a validade a cada uso (sessão deslizante)
      const ttl = await getInt('SESSION_TTL_HOURS');
      await pool.query(
        `UPDATE sessions SET last_seen_at = NOW(), expires_at = NOW() + make_interval(hours => $2) WHERE id = $1`,
        [row.session_id, ttl]
      );
      res.cookie(SESSION_COOKIE, token, cookieOpts(ttl * 3600 * 1000));

      const user = await loadSessionUser(row);
      user.sessionId = row.session_id;
      (req as any).user = user;
      (req as any).sessionLocked = Boolean(row.locked_at);
      (req as any).reauthAt = row.reauth_at ? new Date(row.reauth_at) : null;

      const url = req.originalUrl.split('?')[0];
      // O envio de pontos do rastreamento (app em segundo plano) continua mesmo com a tela bloqueada
      const trackingUpload = req.method === 'POST' && /^\/api\/tracking\/sessions\/[^/]+\/(points|finish)$/.test(url);
      if (row.locked_at && !LOCKED_ALLOWED.has(url) && !trackingUpload) {
        throw new HttpError(423, 'A tela está bloqueada por inatividade. Desbloqueie para continuar.', 'SESSION_LOCKED');
      }
      if (user.mustChangePassword && !MUST_CHANGE_ALLOWED.has(url)) {
        throw new HttpError(403, 'Troque a sua senha para continuar.', 'MUST_CHANGE_PASSWORD');
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireCapability(cap: Capability) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = (req as any).user as SessionUser;
    if (!user || !can(user.role, cap)) return next(new HttpError(403, 'Você não tem permissão para esta área.', 'FORBIDDEN'));
    next();
  };
}

/** Telas sensíveis (Integração): pedem a senha de novo a cada 10 minutos */
export function requireRecentReauth(req: Request, _res: Response, next: NextFunction) {
  const at: Date | null = (req as any).reauthAt;
  if (!at || Date.now() - at.getTime() > REAUTH_MINUTES * 60 * 1000) {
    return next(new HttpError(428, 'Confirme a sua senha para acessar esta área.', 'REAUTH_REQUIRED'));
  }
  next();
}

export const userOf = (req: Request) => (req as any).user as SessionUser;
