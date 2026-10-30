import crypto from 'crypto';
import { pool } from './db';

/**
 * Configurações do RASTRO.
 * Precedência: Banco (tela Integração) > .env > valor padrão. Cada valor informa de onde veio.
 * Segredos ficam criptografados (AES-256-GCM) e nunca voltam para a tela: só "configurado" e o final.
 */

export type SettingSource = 'database' | 'env' | 'default';

type Kind = 'text' | 'int' | 'bool' | 'email' | 'url' | 'secret';
interface SettingDef {
  label: string;
  group: 'smtp' | 'security' | 'admin' | 'map' | 'coverage';
  kind: Kind;
  default: string;
  min?: number;
  max?: number;
  help?: string;
}

export const SETTINGS: Record<string, SettingDef> = {
  SMTP_HOST: { label: 'Servidor SMTP', group: 'smtp', kind: 'text', default: '' },
  SMTP_PORT: { label: 'Porta', group: 'smtp', kind: 'int', default: '587', min: 1, max: 65535 },
  SMTP_SECURE: { label: 'Conexão segura direta (SSL/TLS, porta 465)', group: 'smtp', kind: 'bool', default: 'false' },
  SMTP_USER: { label: 'Usuário', group: 'smtp', kind: 'text', default: '' },
  SMTP_PASS: { label: 'Senha', group: 'smtp', kind: 'secret', default: '' },
  SMTP_FROM: { label: 'Remetente', group: 'smtp', kind: 'text', default: '' },

  SESSION_TTL_HOURS: { label: 'Validade da sessão (horas)', group: 'security', kind: 'int', default: '8', min: 1, max: 72 },
  LOCK_IDLE_MINUTES: { label: 'Bloquear a tela após (minutos sem uso)', group: 'security', kind: 'int', default: '10', min: 1, max: 240 },
  PIN_MAX_ATTEMPTS: { label: 'Tentativas de PIN antes de encerrar a sessão', group: 'security', kind: 'int', default: '5', min: 1, max: 20 },

  ADMIN_EMAIL: { label: 'E-mail do administrador principal', group: 'admin', kind: 'email', default: '' },

  BASEMAP_PMTILES_FILE: {
    label: 'Arquivo do mapa de fundo (.pmtiles na pasta basemap/)', group: 'map', kind: 'text', default: '',
    help: 'Nome do arquivo gerado para a região de operação, ex.: regiao.pmtiles',
  },
  BASEMAP_STYLE_URL: {
    label: 'Endereço de estilo de mapa de um provedor (opcional)', group: 'map', kind: 'url', default: '',
    help: 'Use apenas se for contratar um provedor. Quando preenchido, substitui o arquivo .pmtiles.',
  },
  OVERPASS_URL: {
    label: 'Serviço de ruas (Overpass API)', group: 'map', kind: 'url', default: 'https://overpass-api.de/api/interpreter',
    help: 'Usado para buscar as ruas do OpenStreetMap dentro do território de uma campanha.',
  },
  NOMINATIM_URL: {
    label: 'Serviço de busca de endereços (Nominatim)', group: 'map', kind: 'url', default: 'https://nominatim.openstreetmap.org',
    help: 'O serviço público aceita no máximo 1 busca por segundo. O RASTRO respeita esse limite.',
  },

  COVERAGE_MAX_ACCURACY_M: {
    label: 'Precisão mínima do GPS para contar (metros)', group: 'coverage', kind: 'int', default: '30', min: 5, max: 200,
    help: 'Pontos com precisão pior que isto não entram no cálculo. Valor inicial: calibrar no piloto.',
  },
  COVERAGE_BUFFER_M: {
    label: 'Distância máxima entre o percurso e a rua (metros)', group: 'coverage', kind: 'int', default: '25', min: 5, max: 100,
    help: 'Um trecho de rua conta como percorrido quando o percurso passou a até esta distância. Valor inicial: calibrar no piloto.',
  },
  COVERAGE_STREET_DONE_PCT: {
    label: 'Rua percorrida a partir de (% do comprimento)', group: 'coverage', kind: 'int', default: '80', min: 10, max: 100,
  },
  COVERAGE_STREET_PARTIAL_PCT: {
    label: 'Rua parcialmente percorrida a partir de (% do comprimento)', group: 'coverage', kind: 'int', default: '20', min: 1, max: 99,
  },
  COVERAGE_MIN_POINTS: {
    label: 'Mínimo de pontos válidos para calcular a cobertura', group: 'coverage', kind: 'int', default: '10', min: 2, max: 1000,
  },
  TRACK_MAX_GAP_SECONDS: {
    label: 'Intervalo máximo entre pontos para ligar o trajeto (segundos)', group: 'coverage', kind: 'int', default: '120', min: 10, max: 3600,
    help: 'Acima disso o percurso é interrompido no mapa (não liga pontos distantes no tempo).',
  },
  TRACK_MAX_GAP_METERS: {
    label: 'Distância máxima entre pontos para ligar o trajeto (metros)', group: 'coverage', kind: 'int', default: '150', min: 10, max: 5000,
  },
  TRACK_MAX_SPEED_KMH: {
    label: 'Velocidade máxima plausível (km/h)', group: 'coverage', kind: 'int', default: '60', min: 5, max: 200,
    help: 'Saltos acima desta velocidade são tratados como erro de sinal e não ligam o trajeto.',
  },
  TRACKING_STALE_MINUTES: {
    label: 'Considerar "sem comunicação" após (minutos sem pontos)', group: 'coverage', kind: 'int', default: '5', min: 1, max: 120,
  },
};

export type SettingKey = keyof typeof SETTINGS;

// ---------------------------------------------------------------- criptografia (AES-256-GCM)
export function encryptionKey(): Buffer | null {
  const raw = process.env.SETTINGS_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  try {
    const buf = Buffer.from(raw, 'base64');
    return buf.length === 32 ? buf : null;
  } catch {
    return null;
  }
}

export function encrypt(plain: string): string {
  const key = encryptionKey();
  if (!key) throw new Error('SETTINGS_ENCRYPTION_KEY ausente ou inválida (precisa ter 32 bytes em base64).');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decrypt(payload: string): string {
  const key = encryptionKey();
  if (!key) throw new Error('SETTINGS_ENCRYPTION_KEY ausente ou inválida.');
  const [v, iv, tag, data] = payload.split(':');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Segredo em formato desconhecido.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------- leitura
let cache: { at: number; rows: Map<string, { value: string | null; is_secret: boolean; updated_at: Date; updated_by: string | null }> } | null = null;

async function dbRows() {
  if (cache && Date.now() - cache.at < 5_000) return cache.rows;
  const { rows } = await pool.query('SELECT key, value, is_secret, updated_at, updated_by FROM system_settings');
  cache = { at: Date.now(), rows: new Map(rows.map((r) => [r.key, r])) };
  return cache.rows;
}

export function invalidateSettingsCache() {
  cache = null;
}

export async function getSetting(key: SettingKey): Promise<{ value: string; source: SettingSource }> {
  const def = SETTINGS[key];
  const row = (await dbRows()).get(key);
  if (row && row.value !== null && row.value !== '') {
    if (row.is_secret) {
      try {
        return { value: decrypt(row.value), source: 'database' };
      } catch (err) {
        console.error(`[CONFIG] Não foi possível ler o segredo ${key}:`, (err as Error).message);
        return { value: '', source: 'database' };
      }
    }
    return { value: row.value, source: 'database' };
  }
  const env = process.env[key];
  if (env !== undefined && env !== '') return { value: env, source: 'env' };
  return { value: def.default, source: 'default' };
}

export async function getValue(key: SettingKey): Promise<string> {
  return (await getSetting(key)).value;
}

export async function getInt(key: SettingKey): Promise<number> {
  const def = SETTINGS[key];
  const n = parseInt(await getValue(key), 10);
  const fallback = parseInt(def.default, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, def.min ?? n), def.max ?? n);
}

export async function getBool(key: SettingKey): Promise<boolean> {
  return /^(true|1|sim|yes)$/i.test(await getValue(key));
}

/** Resumo para a tela Integração: segredos aparecem só como "configurado" + 4 últimos caracteres. */
export async function settingsSummary() {
  const rows = await dbRows();
  const out: Record<string, unknown>[] = [];
  for (const [key, def] of Object.entries(SETTINGS)) {
    const eff = await getSetting(key as SettingKey);
    const row = rows.get(key);
    const base = {
      key, label: def.label, group: def.group, kind: def.kind, help: def.help ?? null,
      min: def.min ?? null, max: def.max ?? null, default: def.kind === 'secret' ? null : def.default,
      source: eff.source,
      updatedAt: eff.source === 'database' ? row?.updated_at ?? null : null,
      updatedBy: eff.source === 'database' ? row?.updated_by ?? null : null,
    };
    if (def.kind === 'secret') {
      const configured = eff.value.length > 0;
      out.push({ ...base, configured, last4: configured ? eff.value.slice(-4).replace(/./g, (c, i) => (i < 2 ? '•' : c)) : '' });
    } else {
      out.push({ ...base, value: eff.value });
    }
  }
  return out;
}

export function validateSetting(key: string, raw: unknown): string | null {
  const def = SETTINGS[key];
  if (!def) throw new Error(`Configuração desconhecida: ${key}`);
  if (raw === null || raw === undefined || raw === '') return null; // volta para .env / padrão
  const value = String(raw).trim();
  if (value.length > 2000) throw new Error(`${def.label}: valor longo demais.`);
  switch (def.kind) {
    case 'int': {
      if (!/^\d+$/.test(value)) throw new Error(`${def.label}: informe um número inteiro.`);
      const n = Number(value);
      if ((def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max)) {
        throw new Error(`${def.label}: use um valor entre ${def.min} e ${def.max}.`);
      }
      return String(n);
    }
    case 'bool':
      if (!/^(true|false)$/.test(value)) throw new Error(`${def.label}: valor inválido.`);
      return value;
    case 'email':
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error(`${def.label}: e-mail inválido.`);
      return value.toLowerCase();
    case 'url':
      if (!/^https:\/\/[^\s]+$/i.test(value)) throw new Error(`${def.label}: use um endereço que comece com https://`);
      return value;
    default:
      if (key === 'BASEMAP_PMTILES_FILE' && !/^[\w.-]+\.pmtiles$/i.test(value)) {
        throw new Error(`${def.label}: informe só o nome do arquivo, terminado em .pmtiles.`);
      }
      return value;
  }
}

export async function saveSetting(key: string, raw: unknown, by: string) {
  const def = SETTINGS[key];
  const value = validateSetting(key, raw);
  if (value === null) {
    await pool.query('DELETE FROM system_settings WHERE key = $1', [key]);
  } else {
    const stored = def.kind === 'secret' ? encrypt(value) : value;
    await pool.query(
      `INSERT INTO system_settings (key, value, is_secret, updated_at, updated_by) VALUES ($1, $2, $3, NOW(), $4)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, is_secret = EXCLUDED.is_secret, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
      [key, stored, def.kind === 'secret', by]
    );
  }
  invalidateSettingsCache();
}

/** Marcadores internos (não editáveis pela tela) */
export async function getFlag(key: string): Promise<string | null> {
  const { rows } = await pool.query('SELECT value FROM system_settings WHERE key = $1', [`flag:${key}`]);
  return rows[0]?.value ?? null;
}
export async function setFlag(key: string, value: string, by: string) {
  await pool.query(
    `INSERT INTO system_settings (key, value, is_secret, updated_at, updated_by) VALUES ($1, $2, false, NOW(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [`flag:${key}`, value, by]
  );
  invalidateSettingsCache();
}

export async function smtpConfigured(): Promise<boolean> {
  const [host, user, pass, from] = await Promise.all([
    getValue('SMTP_HOST'), getValue('SMTP_USER'), getValue('SMTP_PASS'), getValue('SMTP_FROM'),
  ]);
  return Boolean(host && user && pass && from);
}

/**
 * Modo de configuração inicial: enquanto o SMTP não foi configurado e testado com sucesso,
 * só o desenvolvedor entra (sem 2FA), para conseguir configurar o e-mail.
 */
export async function initialSetupMode(): Promise<boolean> {
  if ((await getFlag('SETUP_COMPLETED')) === 'true') return false;
  return true;
}

export const ENV_READONLY = [
  { key: 'DATABASE_URL', secret: true },
  { key: 'PORT', secret: false },
  { key: 'APP_URL', secret: false },
  { key: 'NODE_ENV', secret: false },
  { key: 'SETTINGS_ENCRYPTION_KEY', secret: true },
  { key: 'DEVELOPER_EMAILS', secret: false },
  { key: 'ADMIN_EMAIL', secret: false },
  { key: 'ADMIN_INITIAL_PASSWORD', secret: true },
  { key: 'SESSION_TTL_HOURS', secret: false },
  { key: 'LOCK_IDLE_MINUTES', secret: false },
  { key: 'PIN_MAX_ATTEMPTS', secret: false },
  { key: 'SMTP_HOST', secret: false },
  { key: 'SMTP_PORT', secret: false },
  { key: 'SMTP_SECURE', secret: false },
  { key: 'SMTP_USER', secret: false },
  { key: 'SMTP_PASS', secret: true },
  { key: 'SMTP_FROM', secret: false },
  { key: 'BASEMAP_DIR', secret: false },
  { key: 'BASEMAP_PMTILES_FILE', secret: false },
  { key: 'OVERPASS_URL', secret: false },
  { key: 'NOMINATIM_URL', secret: false },
];

export function envReadonlySummary() {
  return ENV_READONLY.map(({ key, secret }) => {
    const v = process.env[key];
    const isSet = Boolean(v && v.trim());
    return { key, isSet, value: isSet && !secret ? v : null, secret };
  });
}
