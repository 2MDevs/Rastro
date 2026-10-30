import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { pool } from '../db';
import { h, HttpError } from '../http';
import { audit } from '../audit';
import { requireAuth, requireCapability, requireRecentReauth, userOf, REAUTH_MINUTES } from '../auth/core';
import { createPasswordLink } from '../auth/routes';
import {
  SETTINGS, settingsSummary, saveSetting, envReadonlySummary, encryptionKey, initialSetupMode, setFlag, smtpConfigured, getValue,
} from '../settings';
import { sendMail } from '../mailer';
import { BASEMAP_DIR } from './system';

/** Tela Integração: exclusiva do desenvolvedor e protegida por nova confirmação de senha a cada 10 minutos */
export const integrationRouter = Router();
integrationRouter.use(requireAuth(), requireCapability('integration.manage'));

// Diz à tela se precisa pedir a senha (não exige a confirmação)
integrationRouter.get('/access', h(async (req, res) => {
  const at: Date | null = (req as any).reauthAt;
  const validUntil = at ? new Date(at.getTime() + REAUTH_MINUTES * 60_000) : null;
  return res.json({ unlocked: Boolean(validUntil && validUntil > new Date()), validUntil });
}));

integrationRouter.use(requireRecentReauth);

integrationRouter.get('/settings', h(async (_req, res) => {
  const files = fs.existsSync(BASEMAP_DIR)
    ? fs.readdirSync(BASEMAP_DIR).filter((f) => f.endsWith('.pmtiles')).map((f) => ({ name: f, sizeBytes: fs.statSync(path.join(BASEMAP_DIR, f)).size }))
    : [];
  const { rows } = await pool.query(`SELECT email, created_at, last_login_at, must_change_password FROM users WHERE LOWER(email) = LOWER($1)`, [await getValue('ADMIN_EMAIL')]);
  return res.json({
    settings: await settingsSummary(),
    env: envReadonlySummary(),
    encryptionKeyConfigured: Boolean(encryptionKey()),
    initialSetupMode: await initialSetupMode(),
    smtpConfigured: await smtpConfigured(),
    basemapFiles: files,
    basemapDir: BASEMAP_DIR,
    admin: rows[0] ? { email: rows[0].email, createdAt: rows[0].created_at, lastLoginAt: rows[0].last_login_at, mustChangePassword: rows[0].must_change_password } : null,
  });
}));

integrationRouter.put('/settings', h(async (req, res) => {
  const user = userOf(req);
  const input = req.body?.values;
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Nada para salvar.');
  const keys = Object.keys(input).filter((k) => k in SETTINGS);
  if (!keys.length) throw new HttpError(400, 'Nada para salvar.');
  const changed: string[] = [];
  for (const key of keys) {
    const value = input[key];
    // Segredo vazio na tela significa "manter o atual"; para apagar, a tela manda { clear: true }
    if (SETTINGS[key].kind === 'secret' && (value === '' || value === undefined) && !req.body?.clear?.includes?.(key)) continue;
    try {
      await saveSetting(key, value === undefined ? '' : value, user.email);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    changed.push(SETTINGS[key].label);
  }
  if (changed.length) {
    await audit(req, { action: 'SETTINGS_UPDATED', targetType: 'settings', details: `Alterado: ${changed.join('; ')}.` });
  }
  return res.json({ ok: true, changed: changed.length });
}));

integrationRouter.post('/smtp/test', h(async (req, res) => {
  const user = userOf(req);
  const to = String(req.body?.to || user.email).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new HttpError(400, 'Informe um e-mail válido para o teste.');
  if (!(await smtpConfigured())) throw new HttpError(400, 'Preencha servidor, usuário, senha e remetente antes de testar.');
  try {
    await sendMail(to, 'RASTRO — e-mail de teste', 'E-mail de teste', [
      'Se você recebeu esta mensagem, o envio de e-mails do RASTRO está funcionando.',
      'A partir de agora, o código de verificação por e-mail (2FA) passa a valer para todos os acessos.',
    ]);
  } catch (err) {
    await audit(req, { action: 'SMTP_TESTED', result: 'FAILURE', details: `Falha ao enviar para ${to}: ${(err as Error).message}`.slice(0, 400) });
    throw new HttpError(502, `O servidor de e-mail recusou o envio: ${(err as Error).message}`.slice(0, 300));
  }
  const wasSetup = await initialSetupMode();
  if (wasSetup) await setFlag('SETUP_COMPLETED', 'true', user.email);
  await audit(req, { action: 'SMTP_TESTED', details: `E-mail de teste enviado para ${to}.${wasSetup ? ' Configuração inicial concluída: 2FA ativo para todos.' : ''}` });
  return res.json({ ok: true, setupCompleted: wasSetup });
}));

integrationRouter.post('/admin/send-reset', h(async (req, res) => {
  const email = await getValue('ADMIN_EMAIL');
  if (!email) throw new HttpError(400, 'Defina o e-mail do administrador principal antes.');
  const { rows } = await pool.query(`SELECT id, name, email, status FROM users WHERE LOWER(email) = LOWER($1)`, [email]);
  if (!rows[0]) throw new HttpError(404, 'Não existe usuário com o e-mail do administrador principal.');
  if (rows[0].status !== 'ACTIVE') throw new HttpError(400, 'O administrador principal está bloqueado.');
  await createPasswordLink(rows[0], 'reset', req);
  await audit(req, { action: 'PASSWORD_RESET_REQUESTED', targetType: 'user', targetId: rows[0].id, targetName: rows[0].email, details: 'Enviado pela tela Integração.' });
  return res.json({ ok: true });
}));
