import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { dbHealth } from './db';
import { errorHandler, HttpError } from './http';
import { authRouter } from './auth/routes';
import { requireAuth } from './auth/core';
import { usersRouter } from './routes/users';
import { storesRouter } from './routes/stores';
import { territoriesRouter } from './routes/territories';
import { campaignsRouter } from './routes/campaigns';
import { trackingRouter } from './routes/tracking';
import { devicesRouter, trackersRouter } from './routes/devices';
import { reportsRouter } from './routes/reports';
import { auditRouter } from './routes/auditLogs';
import { systemRouter } from './routes/system';
import { apiKeysRouter } from './routes/apiKeys';
import { integrationRouter } from './routes/integration';
import { systemUpdateRouter } from './routes/systemUpdate';
import { mapRouter, basemapRouter } from './routes/map';
import { eventsHandler } from './services/realtime';

/** Monta a aplicação Express (sem abrir porta): usada pelo servidor e pelos testes */
export function createApp() {
  const app = express();
  const production = process.env.NODE_ENV === 'production';

  app.set('trust proxy', 1); // Nginx na frente: IP real e HTTPS corretos
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: production ? {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:', 'https:'],
        'font-src': ["'self'", 'data:'],
        'connect-src': ["'self'", 'https:'],
        'worker-src': ["'self'", 'blob:'],
        'child-src': ["'self'", 'blob:'],
        'frame-src': ["'self'", 'blob:'],
        'frame-ancestors': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
      },
    } : false,
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: production ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'same-origin' },
  }));
  app.use(cookieParser());
  app.use('/api', express.json({ limit: '1mb' }));
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  // Público: usado pelo indicador "Conectado", pela atualização automática e pelo monitoramento
  app.get('/api/health', async (_req, res) => {
    const db = await dbHealth();
    res.status(db.up ? 200 : 503).json({ status: db.up ? 'UP' : 'DEGRADED', db: db.up ? 'up' : 'down', latencyMs: db.latencyMs, time: new Date().toISOString() });
  });

  app.get('/api/events', requireAuth(), eventsHandler);
  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/stores', storesRouter);
  app.use('/api/territory', territoriesRouter);
  app.use('/api/campaigns', campaignsRouter);
  app.use('/api/tracking', trackingRouter);
  app.use('/api/devices', devicesRouter);
  app.use('/api/trackers', trackersRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/audit', auditRouter);
  app.use('/api/system', systemRouter);
  app.use('/api/integrations', apiKeysRouter);
  app.use('/api/integration', integrationRouter);
  app.use('/api/system-update', systemUpdateRouter);
  app.use('/api/map', mapRouter);
  app.use('/basemap', basemapRouter);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Endereço da API não encontrado.')));
  app.use(errorHandler);
  return app;
}

