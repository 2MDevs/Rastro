import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { h, HttpError } from '../http';
import { audit } from '../audit';
import { requireAuth, requireCapability, userOf } from '../auth/core';
import { broadcast } from '../services/realtime';

/**
 * Botão "Atualizar sistema".
 * O processo web nunca faz o deploy: só grava o pedido em .update/request.
 * O serviço systemd rastro-update.path (instalado por scripts/install-auto-update.sh) percebe o arquivo
 * e roda scripts/update.sh como root: baixa a main, instala, gera o build em pasta separada, troca,
 * reinicia, testa /api/health e volta à versão anterior se algo falhar.
 */
const execFileAsync = promisify(execFile);
export const systemUpdateRouter = Router();

const APP_DIR = process.cwd();
const STATE_DIR = process.env.UPDATE_STATE_DIR || path.join(APP_DIR, '.update');
const REQUEST_FILE = path.join(STATE_DIR, 'request');
const STATUS_FILE = path.join(STATE_DIR, 'status.json');
const LOG_FILE = path.join(STATE_DIR, 'update.log');
const INSTALLED_FILE = path.join(STATE_DIR, 'installed');

type Commit = { commit: string; short: string; message: string; date: string } | null;

const readJson = (f: string) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

async function git(args: string[]) {
  const { stdout } = await execFileAsync('git', ['-c', `safe.directory=${APP_DIR}`, ...args], {
    cwd: APP_DIR, timeout: 15_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

async function currentCommit(): Promise<Commit> {
  try {
    const [commit, short, message, date] = (await git(['log', '-1', '--format=%H%x1f%h%x1f%s%x1f%cI'])).split('\x1f');
    return { commit, short, message, date };
  } catch {
    return null;
  }
}

const branch = () => readJson(INSTALLED_FILE)?.branch || 'main';

let latestCache: { at: number; value: Commit } | null = null;
async function latestCommit(force = false): Promise<Commit> {
  if (!force && latestCache && Date.now() - latestCache.at < 30_000) return latestCache.value;
  let value: Commit = latestCache?.value ?? null;
  try {
    const sha = (await git(['ls-remote', 'origin', `refs/heads/${branch()}`])).split(/\s+/)[0];
    if (/^[0-9a-f]{40}$/i.test(sha)) {
      value = latestCache?.value?.commit === sha ? latestCache.value : { commit: sha, short: sha.slice(0, 7), message: '', date: '' };
      if (value && !value.message) {
        const remote = (await git(['remote', 'get-url', 'origin'])).match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/i);
        if (remote) {
          const r = await fetch(`https://api.github.com/repos/${remote[1]}/${remote[2]}/commits/${sha}`, { headers: { 'User-Agent': 'RASTRO-Updater', Accept: 'application/vnd.github+json' } }).catch(() => null);
          const d: any = r?.ok ? await r.json() : null;
          value = { commit: sha, short: sha.slice(0, 7), message: String(d?.commit?.message || 'Nova versão').split('\n')[0], date: d?.commit?.committer?.date || '' };
        }
      }
    }
  } catch { /* GitHub inacessível: mantém a última informação */ }
  latestCache = { at: Date.now(), value };
  return value;
}

export function isUpdateRunning(): boolean {
  if (fs.existsSync(REQUEST_FILE)) return true;
  const s = readJson(STATUS_FILE);
  if (s?.state !== 'running') return false;
  const started = Date.parse(s.startedAt || '');
  return Number.isFinite(started) && Date.now() - started < 30 * 60_000;
}

/** O que muda entre a versão instalada e a do GitHub (API pública do GitHub, sem alterar o .git local) */
async function pendingChanges(from: string, to: string) {
  try {
    const remote = (await git(['remote', 'get-url', 'origin'])).match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/i);
    if (!remote) return [];
    const r = await fetch(`https://api.github.com/repos/${remote[1]}/${remote[2]}/compare/${from}...${to}`, {
      headers: { 'User-Agent': 'RASTRO-Updater', Accept: 'application/vnd.github+json' },
    });
    if (!r.ok) return [];
    const d: any = await r.json();
    return (d.commits ?? []).reverse().slice(0, 30).map((c: any) => ({
      sha: String(c.sha).slice(0, 7),
      title: String(c.commit?.message || '').split('\n')[0].replace(/^Merge pull request #(\d+) from \S+/, 'Atualização #$1'),
      date: c.commit?.committer?.date ?? null,
    }));
  } catch {
    return [];
  }
}

// Aviso para todos (sino): existe versão nova?
systemUpdateRouter.get('/notice', requireAuth(), h(async (_req, res) => {
  const [cur, latest] = await Promise.all([currentCommit(), latestCommit()]);
  const available = Boolean(cur && latest && cur.commit !== latest.commit);
  return res.json({ updateAvailable: available, running: isUpdateRunning(), version: latest?.short ?? null, message: available ? latest?.message : null, current: cur?.short ?? null });
}));

systemUpdateRouter.use(requireAuth(), requireCapability('integration.manage'));

systemUpdateRouter.get('/status', h(async (req, res) => {
  const force = req.query.check === 'true';
  const [cur, latest] = await Promise.all([currentCommit(), latestCommit(force)]);
  const available = Boolean(cur && latest && cur.commit !== latest.commit);
  return res.json({
    installed: fs.existsSync(INSTALLED_FILE),
    autoUpdate: autoUpdateEnabled(),
    branch: branch(),
    current: cur, latest, updateAvailable: available,
    changes: available && force && cur && latest ? await pendingChanges(cur.commit, latest.commit) : [],
    running: isUpdateRunning(),
    status: readJson(STATUS_FILE),
    log: (() => { try { return fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-80).join('\n'); } catch { return ''; } })(),
  });
}));

systemUpdateRouter.post('/', h(async (req, res) => {
  const user = userOf(req);
  if (!fs.existsSync(INSTALLED_FILE)) {
    throw new HttpError(409, 'A atualização automática ainda não foi instalada nesta VPS. Rode uma vez: sudo bash scripts/install-auto-update.sh');
  }
  if (isUpdateRunning()) throw new HttpError(409, 'Já existe uma atualização em andamento.');
  const cur = await currentCommit();
  fs.writeFileSync(REQUEST_FILE, JSON.stringify({ requestedBy: user.email, requestedAt: new Date().toISOString(), fromCommit: cur?.commit }), { mode: 0o664 });
  await audit(req, { action: 'SYSTEM_UPDATE_REQUESTED', details: `Atualização pedida a partir da versão ${cur?.short ?? 'desconhecida'}.` });
  return res.status(202).json({ ok: true });
}));

/** Atualização automática: ligada, a não ser que AUTO_UPDATE=false no .env */
export const autoUpdateEnabled = () => String(process.env.AUTO_UPDATE ?? 'true').toLowerCase() !== 'false';

/**
 * Vigia o GitHub a cada 30 segundos. Quando aparece versão nova na main (ex.: merge de um Pull Request):
 * - avisa as telas abertas;
 * - com a atualização automática ligada, já pede a atualização sozinho (o mesmo caminho do botão).
 * Se a atualização dessa versão já falhou (e voltou para a anterior), não tenta de novo sozinho: fica para o botão.
 */
export function startUpdateWatcher() {
  let announced = '';
  const tick = async () => {
    const [cur, latest] = await Promise.all([currentCommit(), latestCommit(true)]);
    if (!cur || !latest || latest.commit === cur.commit) return;
    if (latest.commit !== announced) {
      announced = latest.commit;
      broadcast('update', { available: true, version: latest.short });
    }
    if (!autoUpdateEnabled() || !fs.existsSync(INSTALLED_FILE) || isUpdateRunning()) return;
    const last = readJson(STATUS_FILE);
    if (last?.state === 'failed' && last?.toCommit === latest.commit) return;
    fs.writeFileSync(REQUEST_FILE, JSON.stringify({ requestedBy: 'automático (nova versão no GitHub)', requestedAt: new Date().toISOString(), fromCommit: cur.commit }), { mode: 0o664 });
    broadcast('update', { available: true, running: true, version: latest.short });
    console.log(`[atualização] Nova versão ${latest.short} no GitHub: atualização automática pedida.`);
  };
  setTimeout(() => tick().catch(() => {}), 10_000).unref?.();
  setInterval(() => tick().catch(() => {}), 30_000).unref?.();
}
