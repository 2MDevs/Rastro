import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import express from 'express';
import { fileURLToPath } from 'url';
import { migrate } from './server/db';
import { createApp } from './server/app';
import { ensureInitialAdmin } from './server/bootstrap';
import { encryptionKey } from './server/settings';
import { startStaleSessionJob } from './server/routes/tracking';
import { startUpdateWatcher } from './server/routes/systemUpdate';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const production = process.env.NODE_ENV === 'production';

async function main() {
  const applied = await migrate();
  if (applied.length) console.log(`[RASTRO] Migrações aplicadas: ${applied.join(', ')}`);
  await ensureInitialAdmin();
  if (!encryptionKey()) {
    console.warn('[RASTRO] SETTINGS_ENCRYPTION_KEY ausente ou inválida: senhas de e-mail e segredos de webhook não poderão ser salvos pela tela.');
  }

  const app = createApp();

  // Fontes do mapa (rótulos) servidas pelo próprio sistema
  app.use('/map-assets', express.static(path.join(__dirname, 'public', 'map-assets'), { maxAge: '30d', fallthrough: false }));

  if (!production) {
    const { createServer } = await import('vite');
    const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const dist = path.join(__dirname, 'dist');
    if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('Build não encontrado. Rode "npm run build" antes de iniciar em produção.');
    const noCache = (res: express.Response) => res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    app.use(express.static(dist, {
      index: false,
      setHeaders: (res, file) => {
        if (/[\\/]assets[\\/]/.test(file)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else if (/(\.html|\.webmanifest|sw\.js)$/.test(file)) noCache(res);
      },
    }));
    app.get('*', (_req, res) => {
      noCache(res);
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[RASTRO] Rodando em http://0.0.0.0:${PORT} (${production ? 'produção' : 'desenvolvimento'})`);
    startStaleSessionJob();
    startUpdateWatcher();
  });
}

main().catch((err) => {
  console.error('[RASTRO] Falha ao iniciar:', err);
  process.exit(1);
});
