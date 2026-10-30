import type { Request, Response } from 'express';
import type { SessionUser } from '../access';
import { hasStoreAccess } from '../access';

/**
 * Tempo real por SSE (Server-Sent Events).
 * Cada evento leva a loja de origem: só chega a quem tem acesso àquela loja.
 * Eventos sem loja (ex.: aviso de atualização do sistema) vão para todos.
 */

interface Client { res: Response; user: SessionUser }
const clients = new Set<Client>();

export function eventsHandler(req: Request, res: Response) {
  const user = (req as any).user as SessionUser;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Nginx: não segurar os eventos
  });
  res.write(`retry: 5000\n\n`);
  const client = { res, user };
  clients.add(client);
  const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(client);
  });
}

export function broadcast(type: string, data: Record<string, unknown>, storeId?: string | null, filter?: (u: SessionUser) => boolean) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (storeId && !hasStoreAccess(c.user, storeId)) continue;
    if (filter && !filter(c.user)) continue;
    try {
      c.res.write(payload);
    } catch {
      clients.delete(c);
    }
  }
}

/** Encerra os canais de uma pessoa (ex.: bloqueada) */
export function dropUserStreams(userId: string) {
  for (const c of clients) if (c.user.id === userId) { try { c.res.end(); } catch {} clients.delete(c); }
}

export const realtimeClients = () => clients.size;
