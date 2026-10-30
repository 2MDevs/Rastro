import { PIN_PATH, PIN_SIZE, WORD_PATH, WORD_SIZE } from './paths';

/** Símbolo RASTRO (pin com trajeto) */
export function Symbol({ size = 32, className = '', color = '#F6D35C' }: { size?: number; className?: string; color?: string }) {
  return (
    <svg viewBox={`0 0 ${PIN_SIZE.w} ${PIN_SIZE.h}`} height={size} width={(size * PIN_SIZE.w) / PIN_SIZE.h} className={className} aria-hidden="true">
      <path fillRule="evenodd" fill={color} d={PIN_PATH} />
    </svg>
  );
}

/** Logotipo horizontal: símbolo + RASTRO (+ assinatura opcional). A palavra usa a cor do texto (currentColor). */
export function Logo({ height = 36, tagline = false, className = '' }: { height?: number; tagline?: boolean; className?: string }) {
  const gap = 45, top = 50;
  const w = PIN_SIZE.w + gap + WORD_SIZE.w;
  const wordLeftPct = ((PIN_SIZE.w + gap) / w) * 100;
  return (
    <div className={`inline-flex flex-col ${className}`} role="img" aria-label="RASTRO — Inteligência em movimento">
      <svg viewBox={`0 0 ${w} ${PIN_SIZE.h}`} height={height} width={(height * w) / PIN_SIZE.h} aria-hidden="true">
        <path fillRule="evenodd" fill="#F6D35C" d={PIN_PATH} />
        <path fillRule="evenodd" fill="currentColor" transform={`translate(${PIN_SIZE.w + gap} ${top})`} d={WORD_PATH} />
      </svg>
      {tagline && (
        <span
          className="font-semibold uppercase text-amarelo whitespace-nowrap"
          style={{ fontSize: height * 0.13, letterSpacing: '0.32em', marginLeft: `${wordLeftPct}%`, marginTop: -height * 0.12 }}
        >
          Inteligência em movimento.
        </span>
      )}
    </div>
  );
}
