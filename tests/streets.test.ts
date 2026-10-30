import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import http from 'http';
import { completeSetup, createStore, createUser, login, resetDb } from './helpers';

// Overpass simulado: uma rua atravessando o território e uma totalmente fora dele
const base = { lat: -22.9, lng: -43.18 };
let server: http.Server;
let lastQuery = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      lastQuery = decodeURIComponent(body.replace(/\+/g, ' '));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ elements: [
        { type: 'way', id: 101, tags: { highway: 'residential', name: 'Rua Atravessa' }, geometry: [{ lat: base.lat, lon: base.lng - 0.02 }, { lat: base.lat, lon: base.lng + 0.02 }] },
        { type: 'way', id: 202, tags: { highway: 'residential', name: 'Rua Longe' }, geometry: [{ lat: base.lat + 0.05, lon: base.lng }, { lat: base.lat + 0.05, lon: base.lng + 0.01 }] },
      ] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  process.env.OVERPASS_URL = `http://127.0.0.1:${(server.address() as any).port}/api/interpreter`;
  await resetDb();
  await completeSetup();
});
afterAll(() => server.close());

describe('planejamento de ruas', () => {
  it('busca, recorta pelo território e salva a escolha', async () => {
    const loja = await createStore('S', base);
    const g = await login((await createUser('STORE_MANAGER', { stores: [loja] })).email);
    const area = await g.post('/api/territory/areas').send({ storeId: loja, name: 'Raio', kind: 'RADIUS', radiusM: 500 });
    const c = await g.post('/api/campaigns').send({ storeId: loja, name: 'Ruas', areaId: area.body.id });
    const f = await g.post(`/api/campaigns/${c.body.id}/streets/fetch`).send({});
    expect(f.status).toBe(200);
    expect(lastQuery).toContain('poly:');
    expect(lastQuery).not.toContain('service');
    expect(f.body.found).toBe(1); // a rua longe fica de fora; a que atravessa é recortada
    const list = await g.get(`/api/campaigns/${c.body.id}/streets?candidates=true`);
    const cand = list.body.candidates[0];
    expect(cand.lengthM).toBeGreaterThan(950);
    expect(cand.lengthM).toBeLessThan(1010); // diâmetro do raio de 500 m
    const save = await g.put(`/api/campaigns/${c.body.id}/streets`).send({ keys: [cand.key] });
    expect(save.body).toMatchObject({ planned: 1, added: 1, removed: 0 });
    const again = await g.get(`/api/campaigns/${c.body.id}/streets`);
    expect(again.body.planned).toHaveLength(1);
    expect(again.body.planned[0].name).toBe('Rua Atravessa');
  });
  it('recusa escolher rua que não veio da busca', async () => {
    const loja = await createStore('T', base);
    const g = await login((await createUser('STORE_MANAGER', { stores: [loja] })).email);
    const c = await g.post('/api/campaigns').send({ storeId: loja, name: 'X' });
    const r = await g.put(`/api/campaigns/${c.body.id}/streets`).send({ keys: ['999:0'] });
    expect(r.status).toBe(400);
  });
});
