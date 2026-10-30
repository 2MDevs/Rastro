-- RASTRO — perfil "Gestor da franquia" e registro da localização da loja pelo GPS.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('DEVELOPER','ADMIN','DIRECTOR','FRANCHISE_MANAGER','COORDINATOR','STORE_MANAGER','PROMOTER'));

-- Como a localização da loja foi registrada (GPS dentro da loja ou marcada no mapa) e por quem
ALTER TABLE stores ADD COLUMN location_source      TEXT CHECK (location_source IS NULL OR location_source IN ('GPS','MAP')),
                   ADD COLUMN location_accuracy_m  REAL,
                   ADD COLUMN location_set_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
                   ADD COLUMN location_set_at      TIMESTAMPTZ;

UPDATE stores SET location_source = 'MAP', location_set_at = updated_at WHERE lat IS NOT NULL AND location_source IS NULL;
