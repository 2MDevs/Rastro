import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';

/** Erro com status HTTP e mensagem pronta para o usuário (em português, sem detalhes técnicos). */
export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export const notFound = (what = 'Registro') => new HttpError(404, `${what} não encontrado.`);
export const forbidden = (msg = 'Você não tem permissão para esta ação.') => new HttpError(403, msg, 'FORBIDDEN');

/** Express 4 não captura erros de funções assíncronas: este envelope repassa ao tratador central. */
export function h(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function clientIp(req: Request): string {
  // trust proxy está ligado: req.ip já considera o X-Forwarded-For do Nginx
  return (req.ip || req.socket.remoteAddress || 'desconhecido').replace(/^::ffff:/, '');
}

export function parseUserAgent(ua: string | undefined) {
  const s = ua || '';
  let os = 'Desconhecido';
  if (/Android/i.test(s)) os = 'Android';
  else if (/iPhone|iPad|iPod/i.test(s)) os = 'iOS';
  else if (/Windows/i.test(s)) os = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(s)) os = 'macOS';
  else if (/Linux/i.test(s)) os = 'Linux';
  let browser = 'Desconhecido';
  if (/Edg\//.test(s)) browser = 'Edge';
  else if (/OPR\//.test(s)) browser = 'Opera';
  else if (/Firefox\//.test(s)) browser = 'Firefox';
  else if (/Chrome\//.test(s)) browser = 'Chrome';
  else if (/Safari\//.test(s)) browser = 'Safari';
  else if (/RastroAndroid/i.test(s)) browser = 'App RASTRO';
  const deviceType = os === 'Android' || os === 'iOS' ? 'mobile' : 'desktop';
  return { os, browser, deviceType, label: `${browser} em ${os}` };
}

export function deviceLabel(req: Request): string {
  return parseUserAgent(req.headers['user-agent']).label;
}

/** Valida o corpo/consulta com zod; em caso de erro, devolve 400 com a primeira mensagem. */
export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path?.join('.') || '';
    const message = issue?.message && !/^(Invalid|Expected|Required|Too (small|big)|Unrecognized)|expected /i.test(issue.message)
      ? issue.message
      : `Dado inválido${field ? ` no campo "${field}"` : ''}.`;
    throw new HttpError(400, message, 'VALIDATION');
  }
  return result.data;
}

/** Tratador central: nunca expõe stack, SQL ou mensagens internas. */
export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Os dados enviados são grandes demais.' });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Os dados enviados não estão em um formato válido.' });
  }
  console.error(`[ERRO] ${req.method} ${req.originalUrl}:`, err?.stack || err);
  return res.status(500).json({ error: 'Ocorreu um erro inesperado. Tente novamente.' });
}

export const csvEscape = (v: unknown) => {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Evita que planilhas executem fórmulas vindas de dados (injeção de CSV)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function sendCsv(res: Response, filename: string, header: string[], rows: unknown[][]) {
  const body = [header, ...rows].map((r) => r.map(csvEscape).join(';')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send('﻿' + body);
}
