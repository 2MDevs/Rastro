import crypto from 'crypto';
import { Router, Request } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool, tx } from '../db';
import { h, HttpError, parse, clientIp, deviceLabel } from '../http';
import { audit, writeAuditRaw } from '../audit';
import { initialSetupMode, getInt } from '../settings';
import { send2faCode, sendPasswordLink, maskEmail } from '../mailer';
import { capabilitiesOf, isDeveloperEmail, loadSessionUser, ROLE_LABEL, SessionUser } from '../access';
import {
  authLimiter, createSession, clearSessionCookie, codeHash, currentAuthDevice, newId, randomToken, registerAuthDevice,
  requireAuth, revokeUserSessions, safeEqualHex, sha256, userOf, validatePassword, SESSION_COOKIE, REAUTH_MINUTES,
} from './core';

export const authRouter = Router();

const GENERIC_LOGIN_ERROR = 'E-mail ou senha incorretos.';
const CODE_TTL_MIN = 10;
const RESEND_AFTER_S = 60;
const MAX_CODE_ATTEMPTS = 5;
// Hash fictício: o tempo de resposta é o mesmo com ou sem e-mail cadastrado
const DUMMY_HASH = bcrypt.hashSync('rastro-tempo-constante', 12);

const anonAudit = (req: Request, userRow: any | null, action: string, result: 'SUCCESS' | 'DENIED' | 'BLOCKED' | 'FAILURE', details: string) =>
  writeAuditRaw(
    userRow ? { id: userRow.id, name: userRow.name, role: isDeveloperEmail(userRow.email) ? 'DEVELOPER' : userRow.role } : { id: null, name: 'Desconhecido', role: 'ANONYMOUS' },
    { action, result, details, targetType: 'user', targetId: userRow?.id ?? null, targetName: userRow?.email ?? null },
    { ip: clientIp(req), device: deviceLabel(req) }
  ).catch((err) => console.error('[AUDITORIA]', err.message));

/** Dados da pessoa logada para a interface (sem nada sensível) */
export async function publicUser(user: SessionUser) {
  const stores = user.storeScope === 'ALL'
    ? 'ALL'
    : (await pool.query('SELECT id, code, name FROM stores WHERE id = ANY($1::text[]) ORDER BY name', [user.storeScope])).rows;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    roleLabel: ROLE_LABEL[user.role],
    capabilities: capabilitiesOf(user.role),
    mustChangePassword: user.mustChangePassword,
    hasPin: user.hasPin,
    stores,
  };
}

// ---------------------------------------------------------------- 1. login (senha)
authRouter.post('/login', authLimiter, h(async (req, res) => {
  const body = parse(z.object({ email: z.string().trim().min(3).max(200), password: z.string().min(1).max(200) }), req.body);
  const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [body.email]);
  const user = rows[0];
  if (!user) {
    await bcrypt.compare(body.password, DUMMY_HASH);
    await anonAudit(req, null, 'LOGIN_FAILED', 'DENIED', `Tentativa com e-mail não cadastrado.`);
    throw new HttpError(401, GENERIC_LOGIN_ERROR);
  }
  if (user.status !== 'ACTIVE') {
    await anonAudit(req, user, 'LOGIN_FAILED', 'BLOCKED', 'Conta bloqueada pela administração.');
    throw new HttpError(403, 'Este acesso está bloqueado. Fale com a administração.');
  }
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    const min = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60000);
    await anonAudit(req, user, 'LOGIN_FAILED', 'BLOCKED', 'Tentativa durante o bloqueio temporário.');
    throw new HttpError(429, `Muitas senhas erradas. Tente de novo em ${min} minuto(s).`);
  }
  if (!user.password_hash) {
    throw new HttpError(400, 'Este acesso ainda não tem senha. Use o link recebido por e-mail ou peça um novo à administração.');
  }
  if (!(await bcrypt.compare(body.password, user.password_hash))) {
    const attempts = (user.failed_login_attempts || 0) + 1;
    if (attempts >= 5) {
      await pool.query(`UPDATE users SET failed_login_attempts = 0, locked_until = NOW() + INTERVAL '15 minutes' WHERE id = $1`, [user.id]);
      await anonAudit(req, user, 'LOGIN_BLOCKED', 'BLOCKED', '5 senhas erradas: conta bloqueada por 15 minutos.');
      throw new HttpError(429, 'Você errou a senha 5 vezes. Por segurança, o acesso ficou bloqueado por 15 minutos.');
    }
    await pool.query('UPDATE users SET failed_login_attempts = $2 WHERE id = $1', [user.id, attempts]);
    await anonAudit(req, user, 'LOGIN_FAILED', 'DENIED', `Senha incorreta (${attempts} de 5).`);
    throw new HttpError(401, GENERIC_LOGIN_ERROR);
  }
  await pool.query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1', [user.id]);

  // Configuração inicial: enquanto o e-mail não está configurado e testado, só o desenvolvedor
  // e o administrador inicial (ADMIN_EMAIL) entram, sem 2FA — para cadastrar a equipe e configurar o e-mail
  if (await initialSetupMode()) {
    const initialAdmin = (process.env.ADMIN_EMAIL || '').trim().toLowerCase() === String(user.email).toLowerCase();
    if (!isDeveloperEmail(user.email) && !initialAdmin) {
      await anonAudit(req, user, 'LOGIN_FAILED', 'DENIED', 'Sistema em configuração inicial (e-mail ainda não configurado).');
      throw new HttpError(503, 'O RASTRO ainda está sendo configurado pela equipe de TI. Tente novamente mais tarde.');
    }
    await createSession(user.id, null, req, res);
    await anonAudit(req, user, 'LOGIN_INITIAL_SETUP', 'SUCCESS', 'Entrada sem 2FA: o e-mail (SMTP) ainda não foi configurado e testado.');
    return res.json({ ok: true, initialSetupMode: true });
  }

  // Dispositivo confiável (30 dias) dispensa o código; primeiro acesso sempre pede
  const device = await currentAuthDevice(req, user.id);
  if (device?.status === 'BLOCKED') {
    await anonAudit(req, user, 'LOGIN_FAILED', 'BLOCKED', 'Tentativa a partir de dispositivo bloqueado.');
    throw new HttpError(403, 'Este dispositivo está bloqueado. Fale com a administração.');
  }
  if (device?.trusted_now && user.last_login_at) {
    await pool.query('UPDATE auth_devices SET last_seen_at = NOW(), ip = $2 WHERE id = $1', [device.id, clientIp(req)]);
    await createSession(user.id, device.id, req, res);
    await anonAudit(req, user, 'LOGIN', 'SUCCESS', 'Entrada por dispositivo confiável.');
    return res.json({ ok: true });
  }

  // Novo dispositivo: código de 6 dígitos por e-mail
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const challengeToken = randomToken();
  await pool.query(
    `UPDATE login_challenges SET consumed_at = NOW() WHERE user_id = $1 AND consumed_at IS NULL`, [user.id]
  );
  await pool.query(
    `INSERT INTO login_challenges (id, user_id, token_hash, code_hash, expires_at, first_access)
     VALUES ($1, $2, $3, $4, NOW() + make_interval(mins => $5), $6)`,
    [newId('chl'), user.id, sha256(challengeToken), codeHash(code), CODE_TTL_MIN, !user.last_login_at]
  );
  try {
    await send2faCode(user.email, user.name, code, !user.last_login_at);
  } catch (err) {
    console.error('[2FA] Falha ao enviar e-mail:', (err as Error).message);
    throw new HttpError(502, 'Não foi possível enviar o código para o seu e-mail agora. Tente novamente em instantes.');
  }
  await anonAudit(req, user, 'TWO_FACTOR_SENT', 'SUCCESS', 'Código de verificação enviado por e-mail (dispositivo novo).');
  return res.json({
    require2FA: true,
    challengeToken,
    maskedEmail: maskEmail(user.email),
    firstAccess: !user.last_login_at,
    resendAfterSeconds: RESEND_AFTER_S,
    expiresInMinutes: CODE_TTL_MIN,
  });
}));

async function loadChallenge(token: unknown) {
  if (typeof token !== 'string' || token.length !== 64) throw new HttpError(400, 'O código expirou. Volte e entre de novo.');
  const { rows } = await pool.query(
    `SELECT c.*, u.email, u.name, u.role, u.status, u.last_login_at
       FROM login_challenges c JOIN users u ON u.id = c.user_id
      WHERE c.token_hash = $1 AND c.consumed_at IS NULL AND c.expires_at > NOW()`,
    [sha256(token)]
  );
  if (!rows[0] || !rows[0].code_hash) throw new HttpError(400, 'O código expirou. Volte e entre de novo.');
  return rows[0];
}

// ---------------------------------------------------------------- 2. confirmação do código
authRouter.post('/verify-2fa', authLimiter, h(async (req, res) => {
  const body = parse(z.object({
    challengeToken: z.string(),
    code: z.string().trim(),
    trustDevice: z.boolean().optional().default(false),
    deviceName: z.string().max(80).optional(),
  }), req.body);
  const ch = await loadChallenge(body.challengeToken);
  if (ch.status !== 'ACTIVE') throw new HttpError(403, 'Este acesso está bloqueado. Fale com a administração.');
  const code = body.code.replace(/\D/g, '');
  if (code.length !== 6 || !safeEqualHex(ch.code_hash, codeHash(code))) {
    const attempts = ch.attempts + 1;
    if (attempts >= MAX_CODE_ATTEMPTS) {
      await pool.query('UPDATE login_challenges SET attempts = $2, code_hash = NULL, consumed_at = NOW() WHERE id = $1', [ch.id, attempts]);
      await anonAudit(req, { id: ch.user_id, name: ch.name, email: ch.email, role: ch.role }, 'TWO_FACTOR_FAILED', 'BLOCKED', 'Código errado 5 vezes: código invalidado.');
      throw new HttpError(400, 'Você errou o código 5 vezes. Por segurança ele foi cancelado. Volte e entre de novo.', 'CODE_INVALIDATED');
    }
    await pool.query('UPDATE login_challenges SET attempts = $2 WHERE id = $1', [ch.id, attempts]);
    await anonAudit(req, { id: ch.user_id, name: ch.name, email: ch.email, role: ch.role }, 'TWO_FACTOR_FAILED', 'DENIED', `Código incorreto (${attempts} de ${MAX_CODE_ATTEMPTS}).`);
    throw new HttpError(400, `Código incorreto. Restam ${MAX_CODE_ATTEMPTS - attempts} tentativa(s).`);
  }
  await tx(async (db) => {
    const done = await db.query('UPDATE login_challenges SET consumed_at = NOW(), code_hash = NULL WHERE id = $1 AND consumed_at IS NULL', [ch.id]);
    if (done.rowCount !== 1) throw new HttpError(400, 'O código expirou. Volte e entre de novo.');
    const deviceId = await registerAuthDevice(ch.user_id, body.trustDevice, body.deviceName, req, res, db);
    await createSession(ch.user_id, deviceId, req, res, db);
  });
  await anonAudit(req, { id: ch.user_id, name: ch.name, email: ch.email, role: ch.role }, 'TWO_FACTOR_VERIFIED', 'SUCCESS',
    body.trustDevice ? 'Código confirmado. Dispositivo marcado como confiável por 30 dias.' : 'Código confirmado (dispositivo não marcado como confiável).');
  await anonAudit(req, { id: ch.user_id, name: ch.name, email: ch.email, role: ch.role }, 'LOGIN', 'SUCCESS', 'Entrada com verificação em duas etapas.');
  return res.json({ ok: true });
}));

// ---------------------------------------------------------------- 3. reenviar código (após 60 s)
authRouter.post('/resend-2fa', authLimiter, h(async (req, res) => {
  const ch = await loadChallenge(req.body?.challengeToken);
  const elapsed = (Date.now() - new Date(ch.last_sent_at).getTime()) / 1000;
  if (elapsed < RESEND_AFTER_S) {
    throw new HttpError(429, `Aguarde ${Math.ceil(RESEND_AFTER_S - elapsed)} segundos para pedir outro código.`);
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await pool.query(
    `UPDATE login_challenges SET code_hash = $2, attempts = 0, last_sent_at = NOW(), expires_at = NOW() + make_interval(mins => $3) WHERE id = $1`,
    [ch.id, codeHash(code), CODE_TTL_MIN]
  );
  try {
    await send2faCode(ch.email, ch.name, code, ch.first_access);
  } catch (err) {
    console.error('[2FA] Falha ao reenviar e-mail:', (err as Error).message);
    throw new HttpError(502, 'Não foi possível enviar o código agora. Tente novamente em instantes.');
  }
  await anonAudit(req, { id: ch.user_id, name: ch.name, email: ch.email, role: ch.role }, 'TWO_FACTOR_SENT', 'SUCCESS', 'Código reenviado.');
  return res.json({ ok: true, maskedEmail: maskEmail(ch.email), resendAfterSeconds: RESEND_AFTER_S });
}));

// ---------------------------------------------------------------- sessão atual / saída
authRouter.get('/me', requireAuth(), h(async (req, res) => {
  const user = userOf(req);
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ user: await publicUser(user), sessionLocked: Boolean((req as any).sessionLocked) });
}));

authRouter.post('/logout', h(async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    const { rows } = await pool.query(
      `UPDATE sessions s SET revoked_at = NOW() FROM users u WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND u.id = s.user_id
       RETURNING u.id, u.name, u.email, u.role`,
      [sha256(token)]
    );
    if (rows[0]) await anonAudit(req, rows[0], 'LOGOUT', 'SUCCESS', 'Saída do sistema.');
  }
  clearSessionCookie(res);
  return res.json({ ok: true });
}));

// ---------------------------------------------------------------- senha: esqueci / link / troca
authRouter.post('/forgot-password', authLimiter, h(async (req, res) => {
  const { email } = parse(z.object({ email: z.string().trim().email('Informe um e-mail válido.').max(200) }), req.body);
  const { rows } = await pool.query(`SELECT id, name, email, role, status FROM users WHERE LOWER(email) = LOWER($1)`, [email]);
  const user = rows[0];
  if (user && user.status === 'ACTIVE') {
    await createPasswordLink(user, 'reset', req);
    await anonAudit(req, user, 'PASSWORD_RESET_REQUESTED', 'SUCCESS', 'Link de redefinição enviado por e-mail.');
  }
  // Resposta igual para todos: não revela se o e-mail existe
  return res.json({ ok: true, message: 'Se este e-mail estiver cadastrado, você vai receber um link para criar uma nova senha.' });
}));

export async function createPasswordLink(user: { id: string; name: string; email: string }, purpose: 'reset' | 'invite', req: Request) {
  const token = randomToken();
  const minutes = purpose === 'invite' ? 48 * 60 : 30;
  await pool.query(`UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`, [user.id]);
  await pool.query(
    `INSERT INTO password_resets (id, user_id, token_hash, purpose, expires_at) VALUES ($1, $2, $3, $4, NOW() + make_interval(mins => $5))`,
    [newId('pwr'), user.id, sha256(token), purpose, minutes]
  );
  const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const link = `${base}/definir-senha#${token}`;
  try {
    await sendPasswordLink(user.email, user.name, link, purpose);
  } catch (err) {
    console.error('[SENHA] Falha ao enviar link:', (err as Error).message);
    throw new HttpError(502, 'Não foi possível enviar o e-mail agora. Confira a configuração de e-mail e tente novamente.');
  }
}

authRouter.post('/password-link/check', authLimiter, h(async (req, res) => {
  const token = String(req.body?.token || '');
  const { rows } = await pool.query(
    `SELECT p.purpose, u.name FROM password_resets p JOIN users u ON u.id = p.user_id
      WHERE p.token_hash = $1 AND p.used_at IS NULL AND p.expires_at > NOW() AND u.status = 'ACTIVE'`,
    [sha256(token)]
  );
  if (!rows[0]) throw new HttpError(400, 'Este link expirou ou já foi usado. Peça um novo.');
  return res.json({ valid: true, purpose: rows[0].purpose, name: rows[0].name.split(' ')[0] });
}));

authRouter.post('/password-link/complete', authLimiter, h(async (req, res) => {
  const token = String(req.body?.token || '');
  const password = validatePassword(req.body?.newPassword);
  const hash = await bcrypt.hash(password, 12);
  const user = await tx(async (db) => {
    const { rows } = await db.query(
      `UPDATE password_resets p SET used_at = NOW() FROM users u
        WHERE p.token_hash = $1 AND p.used_at IS NULL AND p.expires_at > NOW() AND u.id = p.user_id AND u.status = 'ACTIVE'
        RETURNING u.id, u.name, u.email, u.role, p.purpose`,
      [sha256(token)]
    );
    if (!rows[0]) throw new HttpError(400, 'Este link expirou ou já foi usado. Peça um novo.');
    await db.query(
      `UPDATE users SET password_hash = $2, must_change_password = false, failed_login_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE id = $1`,
      [rows[0].id, hash]
    );
    await revokeUserSessions(rows[0].id, undefined, db);
    // Trocar a senha tira a confiança dos dispositivos: o próximo acesso pede o código de novo
    await db.query(`UPDATE auth_devices SET status = 'REVOKED', trusted_until = NULL WHERE user_id = $1 AND status = 'TRUSTED'`, [rows[0].id]);
    return rows[0];
  });
  await anonAudit(req, user, 'PASSWORD_RESET', 'SUCCESS', user.purpose === 'invite' ? 'Senha criada pelo link de acesso.' : 'Senha redefinida pelo link.');
  return res.json({ ok: true, message: 'Senha salva. Agora é só entrar.' });
}));

authRouter.post('/change-password', requireAuth(), authLimiter, h(async (req, res) => {
  const user = userOf(req);
  const newPassword = validatePassword(req.body?.newPassword);
  const { rows } = await pool.query('SELECT password_hash, must_change_password FROM users WHERE id = $1', [user.id]);
  const row = rows[0];
  // Troca voluntária exige a senha atual; a obrigatória do primeiro acesso também (é a senha provisória)
  if (!row?.password_hash || !(await bcrypt.compare(String(req.body?.currentPassword || ''), row.password_hash))) {
    await audit(req, { action: 'PASSWORD_CHANGED', result: 'DENIED', details: 'Senha atual incorreta.' });
    throw new HttpError(400, 'A senha atual está incorreta.');
  }
  if (await bcrypt.compare(newPassword, row.password_hash)) throw new HttpError(400, 'A nova senha precisa ser diferente da atual.');
  await pool.query(
    `UPDATE users SET password_hash = $2, must_change_password = false, updated_at = NOW() WHERE id = $1`,
    [user.id, await bcrypt.hash(newPassword, 12)]
  );
  await revokeUserSessions(user.id, user.sessionId);
  await audit(req, { action: 'PASSWORD_CHANGED', details: 'Senha alterada pela própria pessoa. As outras sessões foram encerradas.' });
  return res.json({ ok: true });
}));

// ---------------------------------------------------------------- bloqueio por inatividade e PIN
async function lockPolicy() {
  return { lockIdleMinutes: await getInt('LOCK_IDLE_MINUTES'), pinMaxAttempts: await getInt('PIN_MAX_ATTEMPTS') };
}

authRouter.get('/security-policy', requireAuth(), h(async (req, res) => {
  return res.json({ ...(await lockPolicy()), hasPin: userOf(req).hasPin, sessionLocked: Boolean((req as any).sessionLocked) });
}));

authRouter.post('/lock', requireAuth(), h(async (req, res) => {
  const user = userOf(req);
  const r = await pool.query('UPDATE sessions SET locked_at = NOW() WHERE id = $1 AND locked_at IS NULL', [user.sessionId]);
  if (r.rowCount) await audit(req, { action: 'SESSION_LOCKED', details: 'Tela bloqueada por inatividade.' });
  return res.json({ locked: true });
}));

authRouter.post('/unlock', requireAuth(), h(async (req, res) => {
  const user = userOf(req);
  const { rows } = await pool.query('SELECT password_hash, pin_hash, pin_failed_attempts FROM users WHERE id = $1', [user.id]);
  const row = rows[0];
  const usingPin = Boolean(row.pin_hash);
  const secret = String(usingPin ? req.body?.pin ?? '' : req.body?.password ?? '');
  const ok = secret.length > 0 && (await bcrypt.compare(secret, usingPin ? row.pin_hash : row.password_hash));
  const { pinMaxAttempts } = await lockPolicy();
  if (!ok) {
    const attempts = (row.pin_failed_attempts || 0) + 1;
    if (attempts >= pinMaxAttempts) {
      await pool.query('UPDATE users SET pin_failed_attempts = 0 WHERE id = $1', [user.id]);
      await revokeUserSessions(user.id);
      await audit(req, { action: 'SESSION_UNLOCK_FAILED', result: 'BLOCKED', details: `${pinMaxAttempts} tentativas erradas: todas as sessões foram encerradas.` });
      clearSessionCookie(res);
      throw new HttpError(401, `Você errou ${pinMaxAttempts} vezes. Por segurança, a sessão foi encerrada. Entre novamente.`, 'NO_SESSION');
    }
    await pool.query('UPDATE users SET pin_failed_attempts = $2 WHERE id = $1', [user.id, attempts]);
    await audit(req, { action: 'SESSION_UNLOCK_FAILED', result: 'DENIED', details: `${usingPin ? 'PIN' : 'Senha'} incorreto (${attempts} de ${pinMaxAttempts}).` });
    throw new HttpError(400, `${usingPin ? 'PIN incorreto' : 'Senha incorreta'}. Restam ${pinMaxAttempts - attempts} tentativa(s).`);
  }
  await pool.query('UPDATE users SET pin_failed_attempts = 0 WHERE id = $1', [user.id]);
  await pool.query('UPDATE sessions SET locked_at = NULL WHERE id = $1', [user.sessionId]);
  await audit(req, { action: 'SESSION_UNLOCKED', details: usingPin ? 'Desbloqueio com PIN.' : 'Desbloqueio com senha.' });
  return res.json({ unlocked: true });
}));

async function checkCurrentPassword(userId: string, password: unknown) {
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!rows[0]?.password_hash || !(await bcrypt.compare(String(password || ''), rows[0].password_hash))) {
    throw new HttpError(400, 'A senha atual está incorreta.');
  }
}

authRouter.post('/pin', requireAuth(), authLimiter, h(async (req, res) => {
  const user = userOf(req);
  const pin = String(req.body?.pin || '');
  if (!/^\d{4,8}$/.test(pin)) throw new HttpError(400, 'O PIN precisa ter de 4 a 8 números.');
  if (/^(\d)\1+$/.test(pin) || '01234567890'.includes(pin) || '09876543210'.includes(pin)) {
    throw new HttpError(400, 'Escolha um PIN menos óbvio (sem números repetidos ou em sequência).');
  }
  await checkCurrentPassword(user.id, req.body?.currentPassword);
  await pool.query('UPDATE users SET pin_hash = $2, pin_failed_attempts = 0, updated_at = NOW() WHERE id = $1', [user.id, await bcrypt.hash(pin, 12)]);
  await audit(req, { action: 'PIN_CHANGED', details: 'PIN de desbloqueio criado ou alterado.' });
  return res.json({ ok: true });
}));

authRouter.delete('/pin', requireAuth(), authLimiter, h(async (req, res) => {
  const user = userOf(req);
  await checkCurrentPassword(user.id, req.body?.currentPassword);
  await pool.query('UPDATE users SET pin_hash = NULL, pin_failed_attempts = 0, updated_at = NOW() WHERE id = $1', [user.id]);
  await audit(req, { action: 'PIN_REMOVED', details: 'PIN removido: o desbloqueio passa a pedir a senha.' });
  return res.json({ ok: true });
}));

// ---------------------------------------------------------------- confirmação de senha (áreas restritas)
authRouter.post('/reauth', requireAuth(), authLimiter, h(async (req, res) => {
  const user = userOf(req);
  try {
    await checkCurrentPassword(user.id, req.body?.password);
  } catch (err) {
    await audit(req, { action: 'REAUTH_FAILED', result: 'DENIED', details: 'Senha incorreta ao abrir área restrita.' });
    throw new HttpError(400, 'Senha incorreta.');
  }
  await pool.query('UPDATE sessions SET reauth_at = NOW() WHERE id = $1', [user.sessionId]);
  await audit(req, { action: 'REAUTH', details: `Senha confirmada. Acesso liberado por ${REAUTH_MINUTES} minutos.` });
  return res.json({ ok: true, validForMinutes: REAUTH_MINUTES });
}));

// ---------------------------------------------------------------- minhas sessões
authRouter.get('/sessions', requireAuth(), h(async (req, res) => {
  const user = userOf(req);
  const { rows } = await pool.query(
    `SELECT s.id, s.ip, s.user_agent, s.created_at, s.last_seen_at, s.expires_at, s.locked_at IS NOT NULL AS locked, d.name AS device_name
       FROM sessions s LEFT JOIN auth_devices d ON d.id = s.device_id
      WHERE s.user_id = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW()
      ORDER BY s.last_seen_at DESC`,
    [user.id]
  );
  return res.json(rows.map((r) => ({
    id: r.id, ip: r.ip, deviceName: r.device_name, createdAt: r.created_at, lastSeenAt: r.last_seen_at,
    expiresAt: r.expires_at, locked: r.locked, current: r.id === user.sessionId,
    client: (r.user_agent || '').slice(0, 160),
  })));
}));

authRouter.delete('/sessions/:id', requireAuth(), h(async (req, res) => {
  const user = userOf(req);
  if (req.params.id === user.sessionId) throw new HttpError(400, 'Para encerrar esta sessão, use "Sair".');
  const r = await pool.query('UPDATE sessions SET revoked_at = NOW() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [req.params.id, user.id]);
  if (!r.rowCount) throw new HttpError(404, 'Sessão não encontrada.');
  await audit(req, { action: 'SESSION_ENDED', targetType: 'session', targetId: req.params.id, details: 'Sessão encerrada pela própria pessoa.' });
  return res.json({ ok: true });
}));

authRouter.post('/sessions/end-others', requireAuth(), h(async (req, res) => {
  const user = userOf(req);
  await revokeUserSessions(user.id, user.sessionId);
  await audit(req, { action: 'SESSION_ENDED', details: 'Todas as outras sessões foram encerradas pela própria pessoa.' });
  return res.json({ ok: true });
}));

export { loadSessionUser };
