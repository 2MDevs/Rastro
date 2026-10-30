import { beforeAll, describe, it, expect } from 'vitest';
import { app, completeSetup, createStore, createUser, login, pool, request, resetDb } from './helpers';

let lojaA: string, lojaB: string;
let admin: any, gerenteA: any, gerenteB: any, divulgadorA: any, coord: any;
let campB: string;

beforeAll(async () => {
  await resetDb();
  await completeSetup();
  lojaA = await createStore('A');
  lojaB = await createStore('B');
  admin = await login((await createUser('ADMIN')).email);
  coord = await login((await createUser('COORDINATOR')).email);
  gerenteA = await login((await createUser('STORE_MANAGER', { stores: [lojaA] })).email);
  gerenteB = await login((await createUser('STORE_MANAGER', { stores: [lojaB] })).email);
  divulgadorA = await login((await createUser('PROMOTER', { stores: [lojaA] })).email);
  const c = await gerenteB.post('/api/campaigns').send({ storeId: lojaB, name: 'Campanha da B' });
  campB = c.body.id;
});

describe('isolamento entre lojas', () => {
  it('gerente só lista a própria loja', async () => {
    const r = await gerenteA.get('/api/stores');
    expect(r.body.map((s: any) => s.id)).toEqual([lojaA]);
  });
  it('gerente não abre loja, campanha nem território de outra loja (404)', async () => {
    expect((await gerenteA.get(`/api/stores/${lojaB}`)).status).toBe(404);
    expect((await gerenteA.get(`/api/campaigns/${campB}`)).status).toBe(404);
    expect((await gerenteA.get(`/api/territory/areas?storeId=${lojaB}`)).status).toBe(404);
    expect((await gerenteA.get(`/api/reports/dashboard?storeId=${lojaB}`)).status).toBe(404);
  });
  it('gerente não cria nada em outra loja, mesmo mandando o storeId', async () => {
    expect((await gerenteA.post('/api/campaigns').send({ storeId: lojaB, name: 'Invasão' })).status).toBe(404);
    expect((await gerenteA.post('/api/territory/areas').send({ storeId: lojaB, name: 'X', kind: 'RADIUS', radiusM: 500 })).status).toBe(404);
  });
  it('listas da loja não trazem dados de outra loja', async () => {
    const r = await gerenteA.get('/api/campaigns');
    expect(r.body.some((c: any) => c.storeId === lojaB)).toBe(false);
    const d = await gerenteA.get('/api/reports/dashboard');
    expect(d.body.stores.map((s: any) => s.id)).toEqual([lojaA]);
  });
  it('coordenador (Matriz) vê todas as lojas', async () => {
    const r = await coord.get('/api/stores');
    expect(r.body.map((s: any) => s.id).sort()).toEqual([lojaA, lojaB].sort());
  });
});

describe('permissões por perfil', () => {
  it('coordenador não gerencia usuários nem vê auditoria', async () => {
    expect((await coord.get('/api/users')).status).toBe(403);
    expect((await coord.get('/api/audit')).status).toBe(403);
  });
  it('gerente não cria loja; administrador cria', async () => {
    expect((await gerenteA.post('/api/stores').send({ code: 'C', name: 'Loja C' })).status).toBe(403);
    expect((await admin.post('/api/stores').send({ code: 'C', name: 'Loja C' })).status).toBe(201);
  });
  it('administrador não acessa a tela Integração nem a atualização', async () => {
    expect((await admin.get('/api/integration/settings')).status).toBe(403);
    expect((await admin.post('/api/system-update').send({ password: 'x' })).status).toBe(403);
  });
  it('divulgador não vê campanhas em que não é responsável', async () => {
    await gerenteA.post('/api/campaigns').send({ storeId: lojaA, name: 'Sem divulgador' });
    const r = await divulgadorA.get('/api/campaigns');
    expect(r.body).toEqual([]);
    expect((await divulgadorA.post('/api/campaigns').send({ storeId: lojaA, name: 'x' })).status).toBe(403);
  });
  it('ninguém atribui perfil acima do próprio', async () => {
    const r = await admin.post('/api/users').send({ name: 'Novo Dev', email: 'novo.dev@teste.local', role: 'DEVELOPER' });
    expect(r.status).toBe(403);
  });
  it('gerente e divulgador precisam de loja', async () => {
    const r = await admin.post('/api/users').send({ name: 'Sem Loja', email: 'semloja@teste.local', role: 'PROMOTER', storeIds: [] });
    expect(r.status).toBe(400);
  });
  it('criar usuário envia link para criar a senha (sem senha definida por terceiros)', async () => {
    const r = await admin.post('/api/users').send({ name: 'Divulgador Novo', email: 'div.novo@teste.local', role: 'PROMOTER', storeIds: [lojaA] });
    expect(r.status).toBe(201);
    expect(r.body.inviteSent).toBe(true);
    const { rows } = await pool.query(`SELECT password_hash FROM users WHERE email = 'div.novo@teste.local'`);
    expect(rows[0].password_hash).toBeNull();
  });
});

describe('chaves de API', () => {
  it('chave só consulta o que o escopo permite e nunca entra nas telas de sistema', async () => {
    const k = await admin.post('/api/integrations/keys').send({ name: 'BI', scopes: ['stores:read'] });
    expect(k.status).toBe(201);
    const key = k.body.key as string;
    expect(key).toMatch(/^rst_live_[0-9a-f]{64}$/);
    const auth = { Authorization: `Bearer ${key}` };
    expect((await request(app).get('/api/stores').set(auth)).status).toBe(200);
    expect((await request(app).post('/api/stores').set(auth).send({ code: 'Z', name: 'Z' })).status).toBe(403);
    expect((await request(app).get('/api/campaigns').set(auth)).status).toBe(403);
    expect((await request(app).get('/api/auth/me').set(auth)).status).toBe(401);
    expect((await request(app).get('/api/integrations/keys').set(auth)).status).toBe(401);
    expect((await request(app).get('/api/system/resources').set(auth)).status).toBe(401);
    const { rows } = await pool.query('SELECT key_hash, last_used_at FROM api_keys WHERE id = $1', [k.body.id]);
    expect(rows[0].key_hash).not.toContain(key);
    expect(rows[0].last_used_at).not.toBeNull();
    // revogada para de funcionar
    await admin.post(`/api/integrations/keys/${k.body.id}/revoke`);
    expect((await request(app).get('/api/stores').set(auth)).status).toBe(401);
  });
  it('ações por chave aparecem na auditoria como "Nome (API: chave)"', async () => {
    const k = await admin.post('/api/integrations/keys').send({ name: 'Relatórios', scopes: ['reports:read'] });
    await request(app).get('/api/reports/coverage?format=csv').set({ Authorization: `Bearer ${k.body.key}` });
    const { rows } = await pool.query(`SELECT user_name FROM audit_logs WHERE action = 'REPORT_EXPORTED' ORDER BY seq DESC LIMIT 1`);
    expect(rows[0].user_name).toMatch(/\(API: Relatórios\)$/);
  });
  it('webhook só aceita HTTPS público', async () => {
    expect((await admin.post('/api/integrations/webhooks').send({ name: 'x', url: 'http://exemplo.com/h', events: ['coverage.computed'] })).status).toBe(400);
    expect((await admin.post('/api/integrations/webhooks').send({ name: 'x', url: 'https://127.0.0.1/h', events: ['coverage.computed'] })).status).toBe(400);
    const ok = await admin.post('/api/integrations/webhooks').send({ name: 'x', url: 'https://exemplo.com/h', events: ['coverage.computed'] });
    expect(ok.status).toBe(201);
    const { rows } = await pool.query('SELECT secret_encrypted FROM webhooks WHERE id = $1', [ok.body.id]);
    expect(rows[0].secret_encrypted).not.toContain(ok.body.secret);
  });
});

describe('gestor da franquia', () => {
  let gestor: any, lojaNova: string;
  it('só o administrador cadastra o gestor; o gestor vê todas as lojas', async () => {
    const r = await admin.post('/api/users').send({ name: 'Gestor', email: 'gestor@teste.local', role: 'FRANCHISE_MANAGER' });
    expect(r.status).toBe(201);
    expect((await coord.post('/api/users').send({ name: 'X', email: 'x@teste.local', role: 'FRANCHISE_MANAGER' })).status).toBe(403);
    gestor = await login((await createUser('FRANCHISE_MANAGER')).email);
    const s = await gestor.get('/api/stores');
    expect(s.body.length).toBeGreaterThanOrEqual(2);
  });
  it('cadastra loja e cria/vincula pessoas, mas não cria administrador', async () => {
    const s = await gestor.post('/api/stores').send({ code: 'G1', name: 'Loja do Gestor' });
    const auto = await gestor.post('/api/stores').send({ name: 'Loja sem código' });
    expect(auto.status).toBe(201);
    expect(auto.body.code).toMatch(/^\d{3}$/);
    expect(s.status).toBe(201);
    lojaNova = s.body.id;
    expect((await gestor.post('/api/users').send({ name: 'Adm', email: 'adm2@teste.local', role: 'ADMIN' })).status).toBe(403);
    const u = await gestor.post('/api/users').send({ name: 'Gerente G1', email: 'gerente.g1@teste.local', role: 'STORE_MANAGER', storeIds: [lojaNova] });
    expect(u.status).toBe(201);
    const outro = await createUser('PROMOTER', { stores: [lojaA] });
    expect((await gestor.post(`/api/stores/${lojaNova}/users`).send({ userId: outro.id })).status).toBe(200);
    const p = await gestor.get(`/api/stores/${lojaNova}/users`);
    expect(p.body.linked.map((x: any) => x.email)).toEqual(expect.arrayContaining(['gerente.g1@teste.local', outro.email]));
  });
  it('vê todos os percursos e não vê auditoria nem integração', async () => {
    expect((await gestor.get('/api/tracking/routes')).status).toBe(200);
    expect((await gestor.get('/api/audit')).status).toBe(403);
    expect((await gestor.get('/api/integration/settings')).status).toBe(403);
  });
});

describe('localização da loja pelo GPS', () => {
  const now = () => new Date().toISOString();
  it('gerente registra a localização da própria loja; precisão ruim é recusada', async () => {
    const ok = await gerenteA.put(`/api/stores/${lojaA}/location`).send({ lat: -22.91, lng: -43.17, accuracyM: 12, capturedAt: now(), insideStore: true });
    expect(ok.status).toBe(200);
    expect(ok.body.locationInfo.source).toBe('GPS');
    expect(ok.body.locationInfo.accuracyM).toBe(12);
    const bad = await gerenteA.put(`/api/stores/${lojaA}/location`).send({ lat: -22.91, lng: -43.17, accuracyM: 350, capturedAt: now(), insideStore: true });
    expect(bad.status).toBe(400);
    const sem = await gerenteA.put(`/api/stores/${lojaA}/location`).send({ lat: -22.91, lng: -43.17, accuracyM: 10, capturedAt: now() });
    expect(sem.status).toBe(400);
  });
  it('gerente não registra localização de outra loja e divulgador não registra', async () => {
    expect((await gerenteA.put(`/api/stores/${lojaB}/location`).send({ lat: -22.9, lng: -43.1, accuracyM: 10, capturedAt: now(), insideStore: true })).status).toBe(404);
    expect((await divulgadorA.put(`/api/stores/${lojaA}/location`).send({ lat: -22.9, lng: -43.1, accuracyM: 10, capturedAt: now(), insideStore: true })).status).toBe(403);
  });
});
