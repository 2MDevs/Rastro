import bcrypt from 'bcryptjs';
import request from 'supertest';
import { pool, migrate } from '../server/db';
import { createApp } from '../server/app';
import { memoryOutbox } from '../server/mailer';
import { setFlag, invalidateSettingsCache } from '../server/settings';

export const app = createApp();
export const PASSWORD = 'SenhaForte123';
let n = 0;

export async function resetDb() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  invalidateSettingsCache();
  memoryOutbox.length = 0;
}

/** Sai do modo de configuração inicial (e-mail "testado"): 2FA vale para todos */
export async function completeSetup() {
  await setFlag('SETUP_COMPLETED', 'true', 'teste');
}

export async function createUser(role: string, opts: { stores?: string[]; email?: string; status?: string; mustChange?: boolean } = {}) {
  n++;
  const id = `usr_t${n}_${Date.now()}`;
  const email = opts.email ?? `pessoa${n}@teste.local`;
  await pool.query(
    `INSERT INTO users (id, name, email, role, password_hash, status, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, `Pessoa ${n}`, email, role, await bcrypt.hash(PASSWORD, 4), opts.status ?? 'ACTIVE', opts.mustChange ?? false]
  );
  for (const s of opts.stores ?? []) await pool.query('INSERT INTO user_store_access (user_id, store_id) VALUES ($1,$2)', [id, s]);
  return { id, email };
}

export async function createStore(code: string, loc: { lat: number; lng: number } | null = { lat: -22.9, lng: -43.18 }) {
  const id = `loja_${code}_${Date.now()}`;
  await pool.query('INSERT INTO stores (id, code, name, lat, lng) VALUES ($1,$2,$3,$4,$5)', [id, code, `Loja ${code}`, loc?.lat ?? null, loc?.lng ?? null]);
  return id;
}

export function lastCode(email: string): string {
  const m = [...memoryOutbox].reverse().find((x) => x.to === email && /código/i.test(x.subject));
  const code = m?.subject.match(/(\d{6})/)?.[1];
  if (!code) throw new Error(`Nenhum código enviado para ${email}`);
  return code;
}

/** Faz login completo (senha + código) e devolve o agente com os cookies */
export async function login(email: string, password = PASSWORD, trust = false) {
  const agent = request.agent(app);
  const r = await agent.post('/api/auth/login').send({ email, password });
  if (r.status !== 200) throw new Error(`login falhou: ${r.status} ${JSON.stringify(r.body)}`);
  if (r.body.require2FA) {
    const v = await agent.post('/api/auth/verify-2fa').send({ challengeToken: r.body.challengeToken, code: lastCode(email), trustDevice: trust });
    if (v.status !== 200) throw new Error(`2FA falhou: ${v.status} ${JSON.stringify(v.body)}`);
  }
  return agent;
}

export { pool, request };
