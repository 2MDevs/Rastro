import nodemailer from 'nodemailer';
import { getBool, getInt, getValue, smtpConfigured } from './settings';

/**
 * Envio de e-mails (2FA, acesso inicial, redefinição de senha, teste).
 * Em testes automatizados (NODE_ENV=test e MAIL_TRANSPORT=memory) os e-mails ficam numa lista em memória.
 */

export interface SentMail { to: string; subject: string; text: string; html: string }
export const memoryOutbox: SentMail[] = [];
const memoryMode = () => process.env.NODE_ENV === 'test' && process.env.MAIL_TRANSPORT === 'memory';

async function transport() {
  return nodemailer.createTransport({
    host: await getValue('SMTP_HOST'),
    port: await getInt('SMTP_PORT'),
    secure: await getBool('SMTP_SECURE'),
    auth: { user: await getValue('SMTP_USER'), pass: await getValue('SMTP_PASS') },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#F4F2EA;font-family:Poppins,Segoe UI,Arial,sans-serif;color:#1D1D1B">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px">
  <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#FFFFFF;border-radius:14px;overflow:hidden">
    <tr><td style="background:#1D1D1B;padding:22px 28px">
      <div style="font-size:24px;font-weight:700;letter-spacing:3px;color:#FFFFFF">RASTRO</div>
      <div style="font-size:10px;font-weight:600;letter-spacing:3px;color:#F6D35C;margin-top:2px">INTELIGÊNCIA EM MOVIMENTO.</div>
    </td></tr>
    <tr><td style="padding:28px">
      <h1 style="font-size:18px;margin:0 0 14px">${esc(title)}</h1>
      ${bodyHtml}
    </td></tr>
    <tr><td style="padding:16px 28px;background:#FDF8CF;font-size:11px;color:#4A4A4A">
      Mensagem automática do RASTRO. Não responda este e-mail. Se você não esperava esta mensagem, ignore-a e avise a equipe de TI.
    </td></tr>
  </table></td></tr></table></body></html>`;
}

export async function sendMail(to: string, subject: string, title: string, paragraphs: string[], extraHtml = ''): Promise<void> {
  const html = layout(title, paragraphs.map((p) => `<p style="font-size:14px;line-height:1.6;margin:0 0 12px">${esc(p)}</p>`).join('') + extraHtml);
  const text = [title, '', ...paragraphs].join('\n');
  if (memoryMode()) {
    memoryOutbox.push({ to, subject, text, html });
    return;
  }
  if (!(await smtpConfigured())) throw new Error('SMTP não configurado.');
  const t = await transport();
  await t.sendMail({ from: await getValue('SMTP_FROM'), to, subject, text, html });
}

export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!domain) return '***';
  const visible = user.slice(0, Math.min(2, user.length));
  return `${visible}${'*'.repeat(Math.max(1, user.length - visible.length))}@${domain}`;
}

export async function send2faCode(to: string, name: string, code: string, firstAccess: boolean) {
  const codeHtml = `<div style="font-size:30px;font-weight:700;letter-spacing:8px;background:#1D1D1B;color:#F6D35C;border-radius:10px;padding:14px 0;text-align:center;margin:8px 0 16px">${esc(code)}</div>`;
  await sendMail(
    to,
    `RASTRO — código de verificação ${code}`,
    firstAccess ? 'Seu primeiro acesso ao RASTRO' : 'Código de verificação',
    [
      `Olá, ${name}.`,
      'Use o código abaixo para confirmar a entrada no RASTRO. Ele vale por 10 minutos e só pode ser usado uma vez.',
      `Código: ${code}`,
    ],
    codeHtml
  );
}

export async function sendPasswordLink(to: string, name: string, link: string, purpose: 'reset' | 'invite') {
  const button = `<p style="margin:18px 0"><a href="${esc(link)}" style="background:#F6D35C;color:#1D1D1B;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:10px;display:inline-block">${purpose === 'invite' ? 'Criar minha senha' : 'Redefinir senha'}</a></p>
  <p style="font-size:12px;color:#4A4A4A;word-break:break-all">Se o botão não abrir, copie este endereço no navegador: ${esc(link)}</p>`;
  await sendMail(
    to,
    purpose === 'invite' ? 'RASTRO — seu acesso foi criado' : 'RASTRO — redefinição de senha',
    purpose === 'invite' ? 'Seu acesso ao RASTRO' : 'Redefinir a sua senha',
    purpose === 'invite'
      ? [`Olá, ${name}.`, 'Foi criado um acesso ao RASTRO para você. Clique no botão para criar a sua senha. O link vale por 48 horas e só pode ser usado uma vez.']
      : [`Olá, ${name}.`, 'Recebemos um pedido para redefinir a sua senha. O link vale por 30 minutos e só pode ser usado uma vez. Se não foi você, ignore este e-mail.'],
    button
  );
}
