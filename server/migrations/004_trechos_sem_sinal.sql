-- Trechos sem sinal de GPS: caminho estimado pelas ruas, calculado uma vez e guardado
CREATE TABLE IF NOT EXISTS track_bridges (
  key TEXT PRIMARY KEY,
  geometry JSONB NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('STREETS', 'STRAIGHT')),
  length_m DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
