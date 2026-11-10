/**
 * Lê coordenadas coladas do Google Maps (ou de outro lugar). Aceita:
 *  - "-22.843600277982617, -43.60782515902719"   (clique com o botão direito no Google Maps → copiar)
 *  - "-22.8436 -43.6078" ou "-22.8436; -43.6078"
 *  - "22°50'37.0\"S 43°36'28.2\"W"                (formato graus/minutos/segundos)
 *  - link do Google Maps com "@-22.8436,-43.6078" ou "?q=-22.8436,-43.6078"
 * Devolve null se não entender ou se os números estiverem fora do mundo.
 */
export interface Coords { lat: number; lng: number }

const valid = (lat: number, lng: number) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

function fromPair(a: number, b: number): Coords | null {
  if (valid(a, b)) return { lat: a, lng: b };
  if (valid(b, a)) return { lat: b, lng: a }; // invertido (longitude primeiro)
  return null;
}

export function parseCoords(input: string): Coords | null {
  const text = (input || '').trim();
  if (!text) return null;

  // Link do Google Maps
  // (o ponto exato do lugar, !3d…!4d…, vem antes do centro da tela, @…)
  const at = text.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/)
    || text.match(/[?&](?:q|query|ll|center)=(-?\d{1,3}\.\d+)(?:,|%2C)\s*(-?\d{1,3}\.\d+)/i)
    || text.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (at) return fromPair(parseFloat(at[1]), parseFloat(at[2]));

  // Graus, minutos e segundos: 22°50'37.0"S 43°36'28.2"W
  const dms = [...text.matchAll(/(\d{1,3})\s*°\s*(\d{1,2})?\s*['′]?\s*(\d{1,2}(?:[.,]\d+)?)?\s*["″]?\s*([NSLOEW])/gi)];
  if (dms.length === 2) {
    const val = (m: RegExpMatchArray) => {
      const v = Number(m[1]) + Number(m[2] || 0) / 60 + Number(String(m[3] || 0).replace(',', '.')) / 3600;
      return /[SOW]/i.test(m[4]) ? -v : v;
    };
    const [p, q] = dms;
    const latFirst = /[NS]/i.test(p[4]);
    return latFirst ? fromPair(val(p), val(q)) : fromPair(val(q), val(p));
  }

  // Dois números decimais (ponto como decimal; vírgula, ponto e vírgula ou espaço separando)
  const nums = text.match(/-?\d{1,3}\.\d+/g);
  if (nums && nums.length === 2) return fromPair(parseFloat(nums[0]), parseFloat(nums[1]));
  // Vírgula como decimal: "-22,8436; -43,6078" ou "-22,8436 -43,6078"
  const br = text.match(/^(-?\d{1,3},\d+)\s*[;\s]\s*(-?\d{1,3},\d+)$/);
  if (br) return fromPair(parseFloat(br[1].replace(',', '.')), parseFloat(br[2].replace(',', '.')));
  return null;
}
