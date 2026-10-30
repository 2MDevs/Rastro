import { beforeAll, describe, it, expect } from 'vitest';
import { completeSetup, createUser, login, pool, resetDb } from './helpers';
import { verifyAuditChain } from '../server/audit';

let admin: any;
beforeAll(async () => {
  await resetDb();
  await completeSetup();
  admin = await login((await createUser('ADMIN')).email);
  await admin.post('/api/stores').send({ code: '01', name: 'Loja 01' });
});

describe('auditoria', () => {
  it('registra login, 2FA e ações com IP e dispositivo', async () => {
    const { rows } = await pool.query(`SELECT action, ip, device, result FROM audit_logs ORDER BY seq`);
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['TWO_FACTOR_SENT', 'TWO_FACTOR_VERIFIED', 'LOGIN', 'STORE_CREATED']));
    expect(rows.every((r) => r.ip && r.device)).toBe(true);
  });
  it('a corrente de hashes confere', async () => {
    const r = await verifyAuditChain();
    expect(r.ok).toBe(true);
    expect(r.checked).toBeGreaterThan(3);
  });
  it('o banco recusa alterar ou apagar registros', async () => {
    await expect(pool.query(`UPDATE audit_logs SET details = 'x'`)).rejects.toThrow(/não podem ser alterados/);
    await expect(pool.query(`DELETE FROM audit_logs`)).rejects.toThrow(/não podem ser alterados/);
  });
  it('detecta adulteração feita por fora (desligando a proteção)', async () => {
    await pool.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update');
    await pool.query(`UPDATE audit_logs SET details = 'adulterado' WHERE seq = (SELECT MIN(seq) + 1 FROM audit_logs)`);
    await pool.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_update');
    const r = await verifyAuditChain();
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBeDefined();
  });
  it('a tela de auditoria filtra e exporta CSV', async () => {
    const r = await admin.get('/api/audit?action=STORE_CREATED');
    expect(r.body.entries.every((e: any) => e.action === 'STORE_CREATED')).toBe(true);
    const csv = await admin.get('/api/audit/export.csv');
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('sequencia;data_hora');
  });
});
