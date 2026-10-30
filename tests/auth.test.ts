import { beforeAll, describe, it, expect } from 'vitest';
import { app, completeSetup, createUser, lastCode, login, pool, request, resetDb, PASSWORD } from './helpers';
import { memoryOutbox } from '../server/mailer';

beforeAll(async () => {
  await resetDb();
});

describe('configuração inicial (SMTP ainda não testado)', () => {
  it('só o desenvolvedor entra, sem 2FA', async () => {
    await createUser('ADMIN', { email: 'dev@teste.local' });
    const other = await createUser('ADMIN');
    const dev = await request(app).post('/api/auth/login').send({ email: 'dev@teste.local', password: PASSWORD });
    expect(dev.status).toBe(200);
    expect(dev.body.initialSetupMode).toBe(true);
    const r = await request(app).post('/api/auth/login').send({ email: other.email, password: PASSWORD });
    expect(r.status).toBe(503);
  });
  it('e-mail em DEVELOPER_EMAILS vira Desenvolvedor', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: 'dev@teste.local', password: PASSWORD });
    const me = await agent.get('/api/auth/me');
    expect(me.body.user.role).toBe('DEVELOPER');
    expect(me.body.user.capabilities).toContain('integration.manage');
  });
});

describe('login com senha + código por e-mail', () => {
  beforeAll(completeSetup);

  it('pede código em dispositivo novo e entra com o código certo', async () => {
    const u = await createUser('COORDINATOR');
    const agent = request.agent(app);
    const r = await agent.post('/api/auth/login').send({ email: u.email, password: PASSWORD });
    expect(r.body.require2FA).toBe(true);
    expect(r.body.maskedEmail).not.toContain(u.email);
    expect(JSON.stringify(r.body)).not.toMatch(/\d{6}/);
    const bad = await agent.post('/api/auth/verify-2fa').send({ challengeToken: r.body.challengeToken, code: '000000' });
    expect(bad.status).toBe(400);
    const ok = await agent.post('/api/auth/verify-2fa').send({ challengeToken: r.body.challengeToken, code: lastCode(u.email) });
    expect(ok.status).toBe(200);
    const me = await agent.get('/api/auth/me');
    expect(me.body.user.email).toBe(u.email);
    // o código não pode ser reutilizado
    const again = await request(app).post('/api/auth/verify-2fa').send({ challengeToken: r.body.challengeToken, code: lastCode(u.email) });
    expect(again.status).toBe(400);
  });

  it('código guardado só como hash', async () => {
    const { rows } = await pool.query('SELECT code_hash FROM login_challenges WHERE code_hash IS NOT NULL LIMIT 5');
    for (const r of rows) expect(r.code_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('invalida o código depois de 5 erros', async () => {
    const u = await createUser('COORDINATOR');
    const r = await request(app).post('/api/auth/login').send({ email: u.email, password: PASSWORD });
    let last: any;
    for (let i = 0; i < 5; i++) last = await request(app).post('/api/auth/verify-2fa').send({ challengeToken: r.body.challengeToken, code: '111111' });
    expect(last.body.code).toBe('CODE_INVALIDATED');
    const late = await request(app).post('/api/auth/verify-2fa').send({ challengeToken: r.body.challengeToken, code: lastCode(u.email) });
    expect(late.status).toBe(400);
  });

  it('reenvio só depois de 60 segundos', async () => {
    const u = await createUser('COORDINATOR');
    const r = await request(app).post('/api/auth/login').send({ email: u.email, password: PASSWORD });
    const re = await request(app).post('/api/auth/resend-2fa').send({ challengeToken: r.body.challengeToken });
    expect(re.status).toBe(429);
  });

  it('dispositivo confiável dispensa o código nos próximos acessos', async () => {
    const u = await createUser('COORDINATOR');
    const agent = await login(u.email, PASSWORD, true);
    await agent.post('/api/auth/logout');
    const before = memoryOutbox.length;
    const r = await agent.post('/api/auth/login').send({ email: u.email, password: PASSWORD });
    expect(r.status).toBe(200);
    expect(r.body.require2FA).toBeUndefined();
    expect(memoryOutbox.length).toBe(before);
  });

  it('bloqueia a conta por 15 minutos após 5 senhas erradas', async () => {
    const u = await createUser('COORDINATOR');
    for (let i = 0; i < 4; i++) expect((await request(app).post('/api/auth/login').send({ email: u.email, password: 'errada123456' })).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email: u.email, password: 'errada123456' })).status).toBe(429);
    expect((await request(app).post('/api/auth/login').send({ email: u.email, password: PASSWORD })).status).toBe(429);
  });

  it('mensagem igual para e-mail inexistente e senha errada', async () => {
    const a = await request(app).post('/api/auth/login').send({ email: 'ninguem@teste.local', password: 'qualquer12345' });
    const u = await createUser('COORDINATOR');
    const b = await request(app).post('/api/auth/login').send({ email: u.email, password: 'qualquer12345' });
    expect(a.status).toBe(401);
    expect(a.body.error).toBe(b.body.error);
  });

  it('logout encerra a sessão no banco', async () => {
    const u = await createUser('COORDINATOR');
    const agent = await login(u.email);
    await agent.post('/api/auth/logout');
    expect((await agent.get('/api/auth/me')).status).toBe(401);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1 AND s.revoked_at IS NULL', [u.email]);
    expect(rows[0].n).toBe(0);
  });

  it('sessão guardada só como hash', async () => {
    const { rows } = await pool.query('SELECT token_hash FROM sessions LIMIT 3');
    for (const r of rows) expect(r.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('usuário bloqueado perde todas as sessões na hora', async () => {
    const admin = await createUser('ADMIN');
    const u = await createUser('COORDINATOR');
    const a = await login(admin.email);
    const ua = await login(u.email);
    expect((await ua.get('/api/auth/me')).status).toBe(200);
    expect((await a.post(`/api/users/${u.id}/block`).send({ blocked: true })).status).toBe(200);
    expect((await ua.get('/api/auth/me')).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email: u.email, password: PASSWORD })).status).toBe(403);
  });
});

describe('bloqueio por inatividade e PIN', () => {
  it('tela bloqueada só aceita desbloquear, sair e conferir a sessão', async () => {
    const u = await createUser('COORDINATOR');
    const agent = await login(u.email);
    await agent.post('/api/auth/lock');
    expect((await agent.get('/api/stores')).status).toBe(423);
    expect((await agent.get('/api/auth/me')).body.sessionLocked).toBe(true);
    expect((await agent.post('/api/auth/unlock').send({ password: 'errada12345' })).status).toBe(400);
    expect((await agent.post('/api/auth/unlock').send({ password: PASSWORD })).status).toBe(200);
    expect((await agent.get('/api/stores')).status).toBe(200);
  });

  it('PIN: recusa óbvio, aceita válido e encerra a sessão após 5 erros', async () => {
    const u = await createUser('COORDINATOR');
    const agent = await login(u.email);
    expect((await agent.post('/api/auth/pin').send({ pin: '1234', currentPassword: PASSWORD })).status).toBe(400);
    expect((await agent.post('/api/auth/pin').send({ pin: '4826', currentPassword: PASSWORD })).status).toBe(200);
    await agent.post('/api/auth/lock');
    for (let i = 0; i < 4; i++) expect((await agent.post('/api/auth/unlock').send({ pin: '0000' })).status).toBe(400);
    const last = await agent.post('/api/auth/unlock').send({ pin: '0000' });
    expect(last.status).toBe(401);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });
});

describe('troca de senha', () => {
  it('senha provisória obriga a troca antes de usar o sistema', async () => {
    const u = await createUser('ADMIN', { mustChange: true });
    const agent = await login(u.email);
    expect((await agent.get('/api/stores')).body.code).toBe('MUST_CHANGE_PASSWORD');
    expect((await agent.post('/api/auth/change-password').send({ currentPassword: PASSWORD, newPassword: 'curta' })).status).toBe(400);
    expect((await agent.post('/api/auth/change-password').send({ currentPassword: PASSWORD, newPassword: 'NovaSenha2026x' })).status).toBe(200);
    expect((await agent.get('/api/stores')).status).toBe(200);
  });

  it('link de redefinição é de uso único', async () => {
    const u = await createUser('COORDINATOR');
    await request(app).post('/api/auth/forgot-password').send({ email: u.email });
    const mail = [...memoryOutbox].reverse().find((m) => m.to === u.email && /redefini/i.test(m.subject))!;
    const token = mail.text.match(/definir-senha#([0-9a-f]{64})/)?.[1] ?? mail.html.match(/definir-senha#([0-9a-f]{64})/)![1];
    expect((await request(app).post('/api/auth/password-link/complete').send({ token, newPassword: 'OutraSenha2026' })).status).toBe(200);
    expect((await request(app).post('/api/auth/password-link/complete').send({ token, newPassword: 'OutraSenha2027' })).status).toBe(400);
    const r = await request(app).post('/api/auth/login').send({ email: u.email, password: 'OutraSenha2026' });
    expect(r.status).toBe(200);
  });
});

describe('cabeçalhos de segurança', () => {
  it('sem x-powered-by e com helmet', async () => {
    const r = await request(app).get('/api/health');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.body.db).toBe('up');
  });
  it('erros não expõem detalhes técnicos', async () => {
    const r = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"quebrado":');
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toMatch(/SyntaxError|at .*\.ts/);
  });
});
