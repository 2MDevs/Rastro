const nf = new Intl.NumberFormat('pt-BR');
const nf1 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

export const num = (n: number | null | undefined) => (n === null || n === undefined ? '—' : nf.format(n));

export function distance(m: number | null | undefined) {
  if (m === null || m === undefined) return '—';
  if (m < 1000) return `${nf.format(Math.round(m))} m`;
  return `${nf1.format(m / 1000)} km`;
}

export function area(m2: number | null | undefined) {
  if (m2 === null || m2 === undefined) return '—';
  if (m2 < 100_000) return `${nf.format(Math.round(m2))} m²`;
  return `${nf1.format(m2 / 1_000_000)} km²`;
}

export const pct = (p: number | null | undefined) => (p === null || p === undefined ? '—' : `${nf1.format(p)}%`);

export function duration(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined) return '—';
  const h = Math.floor(seconds / 3600), m = Math.round((seconds % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, '0')}min` : `${m} min`;
}

export function dateTime(v: string | Date | null | undefined) {
  if (!v) return '—';
  const d = new Date(v);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function date(v: string | null | undefined, empty = 'A definir') {
  if (!v) return empty;
  const [y, m, d] = v.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

export function relative(v: string | Date | null | undefined) {
  if (!v) return '—';
  const diff = (Date.now() - new Date(v).getTime()) / 1000;
  if (diff < 60) return 'agora';
  if (diff < 3600) return `há ${Math.round(diff / 60)} min`;
  if (diff < 86400) return `há ${Math.round(diff / 3600)} h`;
  if (diff < 86400 * 30) return `há ${Math.round(diff / 86400)} dia(s)`;
  return dateTime(v);
}

export function bytes(b: number | null | undefined) {
  if (b === null || b === undefined) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${i ? nf1.format(v) : Math.round(v)} ${u[i]}`;
}

export const today = () => new Date().toISOString().slice(0, 10);
export function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
