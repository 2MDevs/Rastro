import { describe, it, expect } from 'vitest';
import { buildTrack, computeStreetCoverage, circlePolygon, polygonArea, normalizePolygon, clipLineToPolygon, lineLength, LngLat } from '../server/services/geo';

const base: LngLat = [-43.18, -22.9];
const t0 = Date.parse('2026-01-01T12:00:00Z');
const params = { maxAccuracyM: 30, maxGapSeconds: 120, maxGapMeters: 150, maxSpeedKmh: 60 };
const pt = (i: number, dLng: number, extra: Partial<{ acc: number | null; dt: number; accepted: boolean; dLat: number }> = {}) => ({
  lng: base[0] + dLng, lat: base[1] + (extra.dLat ?? 0), accuracy_m: extra.acc === undefined ? 8 : extra.acc,
  captured_at: new Date(t0 + (extra.dt ?? i * 5000)).toISOString(), accepted: extra.accepted ?? true,
});

describe('geo: percurso', () => {
  it('não liga pontos separados por um intervalo longo (falha de sinal)', () => {
    const pts = [pt(0, 0), pt(1, 0.00005), pt(2, 0.0001), pt(3, 0.00015, { dt: 10 * 60_000 }), pt(4, 0.0002, { dt: 10 * 60_000 + 5000 })];
    const t = buildTrack(pts, params);
    expect(t.segments.length).toBe(2);
    expect(t.gaps).toBe(1);
  });
  it('descarta pontos imprecisos, recusados e saltos impossíveis', () => {
    const pts = [pt(0, 0), pt(1, 0.00005), pt(2, 0.05), pt(3, 0.0001), pt(4, 0.00015, { acc: 80 }), pt(5, 0.0002, { accepted: false }), pt(6, 0.00025, { acc: null })];
    const t = buildTrack(pts, params);
    expect(t.discarded.jumps).toBe(1);
    expect(t.discarded.lowAccuracy).toBe(2);
    expect(t.discarded.rejected).toBe(1);
    expect(t.segments).toHaveLength(1);
    expect(t.segments[0]).toHaveLength(3);
  });
  it('mede a distância só dos trechos válidos', () => {
    const pts = Array.from({ length: 11 }, (_, i) => pt(i, i * 0.0001)); // ~10 m por ponto
    const t = buildTrack(pts, params);
    expect(t.distanceM).toBeGreaterThan(95);
    expect(t.distanceM).toBeLessThan(110);
  });
});

describe('geo: cobertura', () => {
  const street = { id: 's', name: 'Rua', geometry: { type: 'LineString' as const, coordinates: [base, [base[0] + 0.00486, base[1]] as LngLat] }, lengthM: 0 };
  street.lengthM = lineLength(street.geometry.coordinates);
  it('percurso por metade da rua dá cobertura parcial', () => {
    const seg = Array.from({ length: 37 }, (_, i) => [base[0] + i * 0.0000675, base[1] + 0.00009] as LngLat);
    const [r] = computeStreetCoverage([street], [seg], { bufferM: 25, donePct: 80, partialPct: 20 });
    expect(r.status).toBe('PARTIAL');
    expect(r.coveredPct).toBeGreaterThan(50);
    expect(r.coveredPct).toBeLessThan(60);
  });
  it('percurso longe da rua não conta', () => {
    const seg = [[base[0], base[1] + 0.001], [base[0] + 0.004, base[1] + 0.001]] as LngLat[]; // ~110 m ao norte
    const [r] = computeStreetCoverage([street], [seg], { bufferM: 25, donePct: 80, partialPct: 20 });
    expect(r.status).toBe('PENDING');
    expect(r.coveredPct).toBe(0);
  });
  it('percurso pela rua inteira conta como percorrida', () => {
    const seg = [[base[0] - 0.0001, base[1] + 0.00005], [base[0] + 0.0049, base[1] + 0.00005]] as LngLat[];
    const [r] = computeStreetCoverage([street], [seg], { bufferM: 25, donePct: 80, partialPct: 20 });
    expect(r.status).toBe('DONE');
  });
});

describe('geo: territórios', () => {
  it('área do círculo bate com πr²', () => {
    expect(polygonArea(circlePolygon(base, 1000)) / 1e6).toBeCloseTo(Math.PI, 1);
  });
  it('recusa perímetro com bordas cruzadas', () => {
    expect(() => normalizePolygon({ type: 'Polygon', coordinates: [[[0, 0], [0.01, 0.01], [0.01, 0], [0, 0.01]]] })).toThrow(/cruzam/);
  });
  it('recorta a rua pelo território', () => {
    const pieces = clipLineToPolygon([[-43.1849, -22.9], [-43.1751, -22.9]], circlePolygon(base, 300));
    expect(pieces).toHaveLength(1);
    expect(lineLength(pieces[0])).toBeCloseTo(600, -1);
  });
});
