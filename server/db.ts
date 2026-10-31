import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

if (!process.env.DATABASE_URL) {
  throw new Error('[RASTRO] A variável DATABASE_URL não está definida no .env. O servidor não inicia sem banco de dados.');
}

// Datas sem hora (DATE) voltam como texto AAAA-MM-DD, sem conversão de fuso
pg.types.setTypeParser(1082, (v) => v);
// Contagens (bigint) voltam como número quando cabem com segurança
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : v;
});

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DATABASE_POOL_MAX || 15),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // Fuso da operação: filtros por dia ("hoje", "até 30/10") seguem o horário de Brasília, não o UTC.
  // Sem isso, um percurso iniciado depois das 21h ficava fora do filtro "até hoje".
  options: `-c timezone=${(process.env.APP_TIMEZONE || 'America/Sao_Paulo').replace(/[^A-Za-z0-9_/+-]/g, '')}`,
});

pool.on('error', (err) => {
  console.error('[DB] Erro em conexão ociosa do PostgreSQL:', err.message);
});

export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

/** Executa uma função dentro de uma transação (BEGIN/COMMIT, ROLLBACK em caso de erro). */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Aplica as migrações de server/migrations em ordem, uma única vez cada.
 * Um bloqueio no banco impede que dois processos migrem ao mesmo tempo.
 */
export async function migrate(): Promise<string[]> {
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Falha na migração ${file}: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
  return applied;
}

/** Situação real do banco: conexão e latência medidas agora. */
export async function dbHealth(timeoutMs = 3000): Promise<{ up: boolean; latencyMs: number | null }> {
  const started = Date.now();
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    return { up: true, latencyMs: Date.now() - started };
  } catch {
    return { up: false, latencyMs: null };
  }
}
