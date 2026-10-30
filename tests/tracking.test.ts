import { beforeAll, describe, it, expect } from 'vitest';
import { completeSetup, createStore, createUser, login, pool, resetDb } from './helpers';
import { computeCampaignCoverage } from '../server/services/coverage';

let loja: string, gerente: any, div: any, divId: string, outroDiv: any, camp: string, device: string;
const base = { lat: -22.9, lng: -43.18 };
const t0 = Date.now() - 30 * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

beforeAll(async () => {
  await resetDb();
  await completeSetup();
  loja = await createStore('R', base);
  gerente = await login((await createUser('STORE_MANAGER', { stores: [loja] })).email);
  const d = await createUser('PROMOTER', { stores: [loja] });
  divId = d.id;
  div = await login(d.email);
  outroDiv = await login((await createUser('PROMOTER', { stores: [loja] })).email);
  const area = await gerente.post('/api/territory/areas').send({ storeId: loja, name: 'Raio', kind: 'RADIUS', radiusM: 800 });
  expect(area.status).toBe(201);
  const c = await gerente.post('/api/campaigns').send({ storeId: loja, name: 'Panfletagem', areaId: area.body.id, assigneeIds: [divId] });
  camp = c.body.id;
  // rua planejada reta (~500 m para leste), inserida direto (sem consultar o OpenStreetMap)
  await pool.query(
    `INSERT INTO planned_streets (id, campaign_id, store_id, name, geometry, length_m, min_lat, min_lng, max_lat, max_lng)
     VALUES ('rua1', $1, $2, 'Rua Teste', $3, 497.8, $4, $5, $4, $6)`,
    [camp, loja, JSON.stringify({ type: 'LineString', coordinates: [[base.lng, base.lat], [base.lng + 0.00486, base.lat]] }), base.lat, base.lng, base.lng + 0.00486]
  );
});

describe('sessões de rastreamento', () => {
  it('registra o aparelho do modo campo', async () => {
    const r = await div.post('/api/tracking/devices/register').send({ kind: 'WEB_FIELD', installId: 'instalacao-teste-0001-abcdef', name: 'Celular' });
    expect([200, 201]).toContain(r.status);
    device = r.body.id;
    const { rows } = await pool.query('SELECT install_hash FROM tracker_devices WHERE id = $1', [device]);
    expect(rows[0].install_hash).not.toContain('instalacao');
  });
  it('não começa em campanha que não está ativa', async () => {
    const r = await div.post('/api/tracking/sessions').send({ clientSessionId: 'sess-cliente-0001', campaignId: camp, trackerDeviceId: device });
    expect(r.status).toBe(403);
  });
  it('não começa para quem não é responsável', async () => {
    await gerente.post(`/api/campaigns/${camp}/status`).send({ status: 'ACTIVE' });
    const reg = await outroDiv.post('/api/tracking/devices/register').send({ kind: 'WEB_FIELD', installId: 'instalacao-teste-0002-abcdef', name: 'Outro' });
    const r = await outroDiv.post('/api/tracking/sessions').send({ clientSessionId: 'sess-cliente-0002', campaignId: camp, trackerDeviceId: reg.body.id });
    expect(r.status).toBe(403);
  });
  let sid: string;
  it('começa e é idempotente (mesmo id do aparelho devolve a mesma sessão)', async () => {
    const body = { clientSessionId: 'sess-cliente-0003', campaignId: camp, trackerDeviceId: device, startedAt: iso(t0) };
    const a = await div.post('/api/tracking/sessions').send(body);
    expect(a.status).toBe(201);
    const b = await div.post('/api/tracking/sessions').send(body);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    sid = a.body.id;
    const c = await div.post('/api/tracking/sessions').send({ ...body, clientSessionId: 'sess-cliente-0004' });
    expect(c.status).toBe(409);
  });
  it('recebe pontos sem duplicar e marca os impossíveis como recusados', async () => {
    const pts = Array.from({ length: 37 }, (_, i) => ({ id: `p${i}`, lat: base.lat + 0.00009, lng: base.lng + i * 0.0000675, accuracy: 8, capturedAt: iso(t0 + i * 5000) }));
    const r1 = await div.post(`/api/tracking/sessions/${sid}/points`).send({ points: pts });
    expect(r1.body.inserted).toBe(37);
    const r2 = await div.post(`/api/tracking/sessions/${sid}/points`).send({ points: pts.slice(0, 10) });
    expect(r2.body.inserted).toBe(0);
    expect(r2.body.duplicates).toBe(10);
    const bad = await div.post(`/api/tracking/sessions/${sid}/points`).send({ points: [
      { id: 'futuro', lat: base.lat, lng: base.lng, accuracy: 5, capturedAt: iso(Date.now() + 3600_000) },
      { id: 'zero', lat: 0, lng: 0, accuracy: 5, capturedAt: iso(t0 + 1000) },
    ] });
    expect(bad.body.rejected).toBe(2);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE NOT accepted)::int AS r FROM gps_points WHERE session_id = $1', [sid]);
    expect(rows[0]).toEqual({ n: 39, r: 2 });
  });
  it('outra pessoa não envia pontos para a sessão', async () => {
    const r = await outroDiv.post(`/api/tracking/sessions/${sid}/points`).send({ points: [{ id: 'x', lat: base.lat, lng: base.lng, accuracy: 5, capturedAt: iso(t0) }] });
    expect(r.status).toBe(404);
  });
  it('aparece ao vivo para o gerente da loja', async () => {
    const r = await gerente.get('/api/tracking/live');
    expect(r.body.map((s: any) => s.id)).toContain(sid);
    expect(r.body[0].lastPosition).not.toBeNull();
  });
  it('encerra e aceita pontos que chegam depois (sincronização atrasada)', async () => {
    const f = await div.post(`/api/tracking/sessions/${sid}/finish`).send({ reason: 'USER', pendingPoints: 1, finishedAt: iso(t0 + 37 * 5000) });
    expect(f.body.state).toBe('SYNC_PENDING');
    const late = await div.post(`/api/tracking/sessions/${sid}/points`).send({ points: [{ id: 'atrasado', lat: base.lat + 0.00009, lng: base.lng + 37 * 0.0000675, accuracy: 8, capturedAt: iso(t0 + 37 * 5000) }], pendingPoints: 0 });
    expect(late.body.inserted).toBe(1);
    const s = await gerente.get(`/api/tracking/sessions/${sid}`);
    expect(s.body.state).toBe('FINISHED');
    expect(s.body.track.segments.length).toBe(1);
  });
  it('calcula a cobertura estimada com a metodologia documentada', async () => {
    const r = await computeCampaignCoverage(camp, 'teste');
    expect(r!.status).toBe('OK');
    expect(r!.percent).toBeGreaterThan(50);
    expect(r!.percent).toBeLessThan(62);
    expect(r!.streetsSummary.partial).toBe(1);
  });
  it('consultar o percurso de outra pessoa fica na auditoria', async () => {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = 'SESSION_VIEWED'`);
    expect(rows[0].n).toBeGreaterThan(0);
  });
  it('aparelho bloqueado tem os pontos recusados', async () => {
    await pool.query(`UPDATE tracker_devices SET status = 'BLOCKED' WHERE id = $1`, [device]);
    const r = await div.post(`/api/tracking/sessions/${sid}/points`).send({ points: [{ id: 'y', lat: base.lat, lng: base.lng, accuracy: 5, capturedAt: iso(t0) }] });
    expect(r.status).toBe(403);
  });
});
