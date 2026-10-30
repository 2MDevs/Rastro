import { Router, raw } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { pool, dbHealth } from '../db';
import { h, HttpError } from '../http';
import { audit } from '../audit';
import { requireAuth, requireCapability, userOf } from '../auth/core';
import { can } from '../access';
import { realtimeClients } from '../services/realtime';

const execFileAsync = promisify(execFile);
export const systemRouter = Router();
systemRouter.use(requireAuth(), requireCapability('system.view'));

const APP_DIR = process.cwd();
const DOCS_DIR = path.join(APP_DIR, 'docs');
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(APP_DIR, 'storage');
const ARTIFACT_OVERRIDES = path.join(STORAGE_DIR, 'artifacts');
export const BASEMAP_DIR = process.env.BASEMAP_DIR || path.join(APP_DIR, 'basemap');

// ---------------------------------------------------------------- medições
let lastCpu = process.cpuUsage();
let lastAt = process.hrtime.bigint();
let cpuOfServer = 0;
let cpuOfCore = 0;
let lastSys = os.cpus().map((c) => c.times);
let serverCpu = 0;
const sampler = setInterval(() => {
  const now = process.hrtime.bigint();
  const u = process.cpuUsage(lastCpu);
  const elapsed = Number(now - lastAt) / 1000;
  lastCpu = process.cpuUsage();
  lastAt = now;
  if (elapsed > 0) {
    cpuOfCore = +(((u.user + u.system) / elapsed) * 100).toFixed(1);
    cpuOfServer = +(((u.user + u.system) / elapsed / Math.max(1, os.cpus().length)) * 100).toFixed(2);
  }
  const cur = os.cpus().map((c) => c.times);
  let idle = 0, total = 0;
  cur.forEach((t, i) => {
    const p = lastSys[i] ?? t;
    const d = (k: keyof typeof t) => t[k] - p[k];
    const tt = d('user') + d('nice') + d('sys') + d('idle') + d('irq');
    total += tt; idle += d('idle');
  });
  lastSys = cur;
  if (total > 0) serverCpu = +(((total - idle) / total) * 100).toFixed(1);
}, 5000);
sampler.unref?.();

async function dirSize(dir: string, skip: (p: string) => boolean = () => false): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try { entries = await fs.promises.readdir(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (skip(full)) continue;
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) { try { total += (await fs.promises.stat(full)).size; } catch {} }
    }
  }
  return total;
}

const sizeCache = new Map<string, { at: number; value: number }>();
async function cachedSize(key: string, ttl: number, fn: () => Promise<number>) {
  const hit = sizeCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await fn();
  sizeCache.set(key, { at: Date.now(), value });
  return value;
}

function diskOf(target: string) {
  try {
    const s = fs.statfsSync(fs.existsSync(target) ? target : '/');
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    return { totalBytes: total, freeBytes: free, usedBytes: total - Number(s.bfree) * Number(s.bsize) };
  } catch {
    return null;
  }
}

systemRouter.get('/resources', h(async (_req, res) => {
  const sub = (n: string) => path.join(APP_DIR, n);
  const [deps, build, code, basemap, storage, db, perStore] = await Promise.all([
    cachedSize('deps', 30 * 60_000, () => dirSize(sub('node_modules'))),
    cachedSize('build', 10 * 60_000, async () => (await dirSize(sub('dist'))) + (await dirSize(sub('dist-prev'))) + (await dirSize(sub('dist-next')))),
    cachedSize('code', 30 * 60_000, () => dirSize(APP_DIR, (p) => /[\\/](node_modules|dist|dist-prev|dist-next|\.git|basemap|storage|\.update)$/.test(p))),
    cachedSize('basemap', 10 * 60_000, () => dirSize(BASEMAP_DIR)),
    cachedSize('storage', 10 * 60_000, () => dirSize(STORAGE_DIR)),
    pool.query('SELECT pg_database_size(current_database())::bigint AS bytes').then((r) => Number(r.rows[0].bytes)).catch(() => null),
    // Espaço estimado por loja: pontos GPS, ruas planejadas e territórios (o banco não separa arquivos por loja)
    pool.query(`
      SELECT s.id, s.name, s.code,
        COALESCE((SELECT SUM(pg_column_size(g.*)) FROM gps_points g JOIN tracking_sessions t ON t.id = g.session_id WHERE t.store_id = s.id), 0)::bigint AS gps,
        COALESCE((SELECT SUM(pg_column_size(p.*)) FROM planned_streets p WHERE p.store_id = s.id), 0)::bigint AS streets,
        COALESCE((SELECT SUM(pg_column_size(a.*)) FROM coverage_areas a WHERE a.store_id = s.id), 0)::bigint AS areas,
        (SELECT COUNT(*) FROM gps_points g JOIN tracking_sessions t ON t.id = g.session_id WHERE t.store_id = s.id) AS points
      FROM stores s ORDER BY s.name`).then((r) => r.rows).catch(() => []),
  ]);
  const mem = process.memoryUsage();
  const disk = diskOf(APP_DIR);
  const total = deps + build + code + basemap + storage + (db ?? 0);
  return res.json({
    disk: {
      projectBytes: total,
      parts: { databaseBytes: db, basemapBytes: basemap, storageBytes: storage, dependenciesBytes: deps, buildBytes: build, codeBytes: code },
      serverTotalBytes: disk?.totalBytes ?? null, serverFreeBytes: disk?.freeBytes ?? null, serverUsedBytes: disk?.usedBytes ?? null,
      percentOfServer: disk ? +((total / disk.totalBytes) * 100).toFixed(2) : null,
      perStore: perStore.map((s: any) => ({ id: s.id, name: `${s.name} (${s.code})`, bytes: Number(s.gps) + Number(s.streets) + Number(s.areas), points: Number(s.points) })),
      perStoreNote: 'Estimativa do tamanho dos dados de cada loja dentro do banco (pontos GPS, ruas e territórios). A soma não inclui índices nem dados gerais do sistema.',
    },
    memory: { processBytes: mem.rss, heapUsedBytes: mem.heapUsed, serverTotalBytes: os.totalmem(), serverFreeBytes: os.freemem(), percentOfServer: +((mem.rss / os.totalmem()) * 100).toFixed(2) },
    cpu: { percentOfServer: cpuOfServer, percentOfCore: cpuOfCore, cores: os.cpus().length, serverPercent: serverCpu },
    process: { uptimeSeconds: Math.round(process.uptime()), nodeVersion: process.version, realtimeConnections: realtimeClients() },
  });
}));

systemRouter.get('/server', h(async (_req, res) => {
  const health = await dbHealth();
  const disk = diskOf('/');
  let pgVersion: string | null = null, tables: number | null = null;
  if (health.up) {
    pgVersion = (await pool.query('SHOW server_version')).rows[0]?.server_version ?? null;
    tables = Number((await pool.query(`SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'`)).rows[0].count);
  }
  return res.json({
    hostname: os.hostname(), platform: `${os.type()} ${os.release()}`, arch: os.arch(),
    uptimeSeconds: Math.round(os.uptime()), loadAverage: os.loadavg().map((n) => +n.toFixed(2)), cores: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? null, cpuPercent: serverCpu,
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
    disk,
    database: { connected: health.up, latencyMs: health.latencyMs, version: pgVersion, tables, name: dbName() },
    checkedAt: new Date().toISOString(),
  });
}));

function dbName() {
  try { return new URL(process.env.DATABASE_URL!).pathname.replace('/', '') || null; } catch { return null; }
}

// ---------------------------------------------------------------- artefatos da plataforma
interface ArtifactDef { id: string; name: string; file: string; description: string; version: string }

function readManifest(): ArtifactDef[] {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(DOCS_DIR, 'artifacts.json'), 'utf8'));
    return Array.isArray(list) ? list.filter((a) => /^[\w.-]+$/.test(a.file) && /^[\w-]+$/.test(a.id)) : [];
  } catch {
    return [];
  }
}

function artifactPath(a: ArtifactDef): { path: string; source: 'repositorio' | 'substituido' } | null {
  const override = path.join(ARTIFACT_OVERRIDES, a.file);
  if (fs.existsSync(override)) return { path: override, source: 'substituido' };
  const p = path.join(DOCS_DIR, a.file);
  return fs.existsSync(p) ? { path: p, source: 'repositorio' } : null;
}

const sha256File = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function readIntegrity(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(path.join(ARTIFACT_OVERRIDES, 'integrity.json'), 'utf8')); } catch { return {}; }
}

systemRouter.get('/artifacts', h(async (req, res) => {
  const list = readManifest().map((a) => {
    const loc = artifactPath(a);
    const st = loc ? fs.statSync(loc.path) : null;
    return {
      id: a.id, name: a.name, description: a.description, version: a.version, file: a.file,
      available: Boolean(loc), source: loc?.source ?? null,
      updatedAt: st?.mtime ?? null, sizeBytes: st?.size ?? null,
    };
  });
  return res.json({ artifacts: list, canReplace: can(userOf(req).role, 'infra.destructive') });
}));

systemRouter.get('/artifacts/:id/:mode(view|download)', h(async (req, res) => {
  const a = readManifest().find((x) => x.id === req.params.id);
  const loc = a && artifactPath(a);
  if (!a || !loc) throw new HttpError(404, 'Artefato não encontrado.');
  // Substituídos pela tela têm o hash guardado: confere a integridade antes de entregar
  if (loc.source === 'substituido') {
    const expected = readIntegrity()[a.file];
    if (!expected || expected !== sha256File(loc.path)) {
      await audit(req, { action: req.params.mode === 'view' ? 'ARTIFACT_VIEWED' : 'ARTIFACT_DOWNLOADED', result: 'BLOCKED', targetType: 'artifact', targetName: a.name, details: 'Falha na conferência de integridade (SHA-256).' });
      throw new HttpError(409, 'O arquivo não passou na conferência de integridade. Avise o desenvolvedor.');
    }
  }
  await audit(req, { action: req.params.mode === 'view' ? 'ARTIFACT_VIEWED' : 'ARTIFACT_DOWNLOADED', targetType: 'artifact', targetId: a.id, targetName: a.name, details: `Versão ${a.version}.` });
  const ext = path.extname(a.file).toLowerCase();
  const type = ext === '.pdf' ? 'application/pdf' : ext === '.md' ? 'text/markdown; charset=utf-8' : 'application/octet-stream';
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `${req.params.mode === 'view' ? 'inline' : 'attachment'}; filename="${a.file}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(loc.path).pipe(res);
}));

systemRouter.put('/artifacts/:id', requireCapability('infra.destructive'), raw({ type: 'application/pdf', limit: '25mb' }), h(async (req, res) => {
  const a = readManifest().find((x) => x.id === req.params.id);
  if (!a) throw new HttpError(404, 'Artefato não encontrado.');
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length < 100 || body.subarray(0, 5).toString() !== '%PDF-') {
    throw new HttpError(400, 'Envie um arquivo PDF válido.');
  }
  if (path.extname(a.file).toLowerCase() !== '.pdf') throw new HttpError(400, 'Este artefato não é um PDF.');
  fs.mkdirSync(ARTIFACT_OVERRIDES, { recursive: true });
  const target = path.join(ARTIFACT_OVERRIDES, a.file);
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, target);
  const integrity = readIntegrity();
  integrity[a.file] = crypto.createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(path.join(ARTIFACT_OVERRIDES, 'integrity.json'), JSON.stringify(integrity, null, 2));
  await audit(req, { action: 'ARTIFACT_REPLACED', targetType: 'artifact', targetId: a.id, targetName: a.name, details: `${Math.round(body.length / 1024)} KB. SHA-256: ${integrity[a.file].slice(0, 16)}…` });
  return res.json({ ok: true });
}));

// ---------------------------------------------------------------- notas de versão (Pull Requests aplicados)
let notesCache: { at: number; head: string; value: any[] } | null = null;

async function git(args: string[]) {
  const { stdout } = await execFileAsync('git', ['-c', `safe.directory=${APP_DIR}`, ...args], { cwd: APP_DIR, timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return stdout.trim();
}

const cleanBody = (text: string) => String(text || '')
  .split('\n')
  .map((l) => l.trimEnd())
  .filter((l) => !/^(co-authored-by|claude-session|signed-off-by)\b/i.test(l.trim()) && !/generated with/i.test(l) && !/^https?:\/\/\S+$/.test(l.trim()))
  .join('\n').trim();

systemRouter.get('/release-notes', h(async (_req, res) => {
  let head = '';
  try { head = await git(['rev-parse', 'HEAD']); } catch { return res.json({ available: false, notes: [] }); }
  if (notesCache && notesCache.head === head && Date.now() - notesCache.at < 60 * 60_000) return res.json({ available: true, notes: notesCache.value });
  const log = await git(['log', '-40', '--format=%H%x1f%cI%x1f%s%x1f%b%x1e']).catch(() => '');
  const repo = (await git(['remote', 'get-url', 'origin']).catch(() => '')).match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/i);
  const notes: any[] = [];
  for (const rec of log.split('\x1e').map((r) => r.trim()).filter(Boolean)) {
    const [sha, date, subject, body] = rec.split('\x1f');
    const pr = /^Merge pull request #(\d+)/i.exec(subject || '');
    if (!pr) continue;
    let title = (body || '').split('\n')[0] || `Atualização #${pr[1]}`;
    let description = '';
    if (repo) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 6000);
        const r = await fetch(`https://api.github.com/repos/${repo[1]}/${repo[2]}/pulls/${pr[1]}`, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'RASTRO' }, signal: ctrl.signal,
        });
        clearTimeout(t);
        if (r.ok) {
          const d: any = await r.json();
          title = d.title || title;
          description = cleanBody(d.body || '');
        }
      } catch { /* sem internet: fica só o título */ }
    }
    notes.push({ number: Number(pr[1]), sha: sha.slice(0, 7), date, title, description });
  }
  notesCache = { at: Date.now(), head, value: notes };
  return res.json({ available: true, notes });
}));
