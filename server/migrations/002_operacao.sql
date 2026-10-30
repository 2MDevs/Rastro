-- RASTRO — lojas, territórios, campanhas, ruas planejadas, rastreamento e cobertura.
-- As geometrias ficam em GeoJSON (jsonb) com a caixa envolvente (min/max) em colunas
-- indexadas. Os cálculos geográficos rodam no servidor (server/services/geo.ts), sem PostGIS.

CREATE TABLE stores (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  address     TEXT,
  lat         DOUBLE PRECISION CHECK (lat BETWEEN -90 AND 90),
  lng         DOUBLE PRECISION CHECK (lng BETWEEN -180 AND 180),
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((lat IS NULL) = (lng IS NULL))
);
CREATE UNIQUE INDEX stores_code_uq ON stores (LOWER(code));

-- Quem trabalha em quais lojas (gerente e divulgador; os perfis da Matriz enxergam todas)
CREATE TABLE user_store_access (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_id    TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  granted_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, store_id)
);
CREATE INDEX user_store_access_store_idx ON user_store_access (store_id);

-- Territórios: raio a partir de um centro ou perímetro desenhado
CREATE TABLE coverage_areas (
  id           TEXT PRIMARY KEY,
  store_id     TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('RADIUS','POLYGON')),
  center_lat   DOUBLE PRECISION,
  center_lng   DOUBLE PRECISION,
  radius_m     DOUBLE PRECISION CHECK (radius_m IS NULL OR radius_m > 0),
  geometry     JSONB NOT NULL,
  area_m2      DOUBLE PRECISION NOT NULL,
  min_lat      DOUBLE PRECISION NOT NULL,
  min_lng      DOUBLE PRECISION NOT NULL,
  max_lat      DOUBLE PRECISION NOT NULL,
  max_lng      DOUBLE PRECISION NOT NULL,
  archived_at  TIMESTAMPTZ,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (kind <> 'RADIUS' OR (center_lat IS NOT NULL AND center_lng IS NOT NULL AND radius_m IS NOT NULL))
);
CREATE INDEX coverage_areas_store_idx ON coverage_areas (store_id) WHERE archived_at IS NULL;

CREATE TABLE points_of_interest (
  id          TEXT PRIMARY KEY,
  store_id    TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'Outro',
  notes       TEXT,
  lat         DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng         DOUBLE PRECISION NOT NULL CHECK (lng BETWEEN -180 AND 180),
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX points_of_interest_store_idx ON points_of_interest (store_id);

CREATE TABLE campaigns (
  id                TEXT PRIMARY KEY,
  store_id          TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  name              TEXT NOT NULL,
  description       TEXT,
  coverage_area_id  TEXT REFERENCES coverage_areas(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT','PLANNED','ACTIVE','PAUSED','FINISHED','CANCELLED')),
  start_date        DATE,
  end_date          DATE,
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE INDEX campaigns_store_idx ON campaigns (store_id, status);

CREATE TABLE campaign_assignments (
  campaign_id  TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, user_id)
);
CREATE INDEX campaign_assignments_user_idx ON campaign_assignments (user_id);

CREATE TABLE campaign_history (
  id           BIGSERIAL PRIMARY KEY,
  campaign_id  TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id      TEXT,
  user_name    TEXT NOT NULL,
  action       TEXT NOT NULL,
  details      JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX campaign_history_campaign_idx ON campaign_history (campaign_id, occurred_at DESC);

-- Ruas encontradas na rede viária (OpenStreetMap) para a área da campanha: candidatas a planejar
-- Uma via do OpenStreetMap pode sair e voltar ao território: cada pedaço dentro dele é um "piece".
CREATE TABLE street_candidates (
  campaign_id  TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  osm_way_id   BIGINT NOT NULL,
  piece        INT NOT NULL DEFAULT 0,
  name         TEXT,
  highway      TEXT NOT NULL,
  geometry     JSONB NOT NULL,
  length_m     DOUBLE PRECISION NOT NULL,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, osm_way_id, piece)
);

-- Ruas planejadas ("ruas anunciadas") da campanha
CREATE TABLE planned_streets (
  id           TEXT PRIMARY KEY,
  campaign_id  TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  store_id     TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  osm_way_id   BIGINT,
  piece        INT NOT NULL DEFAULT 0,
  name         TEXT,
  highway      TEXT,
  geometry     JSONB NOT NULL,
  length_m     DOUBLE PRECISION NOT NULL CHECK (length_m > 0),
  min_lat      DOUBLE PRECISION NOT NULL,
  min_lng      DOUBLE PRECISION NOT NULL,
  max_lat      DOUBLE PRECISION NOT NULL,
  max_lng      DOUBLE PRECISION NOT NULL,
  added_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  added_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, osm_way_id, piece)
);
CREATE INDEX planned_streets_campaign_idx ON planned_streets (campaign_id);

-- Aparelhos que coletam GPS (modo campo no navegador, app Android, equipamento dedicado)
CREATE TABLE tracker_devices (
  id            TEXT PRIMARY KEY,
  user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('WEB_FIELD','ANDROID_APP','GPS_DEVICE')),
  name          TEXT NOT NULL,
  install_hash  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BLOCKED','REVOKED')),
  app_version   TEXT,
  last_ip       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ,
  UNIQUE (kind, install_hash)
);

CREATE TABLE tracking_sessions (
  id                       TEXT PRIMARY KEY,
  client_session_id        TEXT UNIQUE,
  campaign_id              TEXT NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  store_id                 TEXT NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  tracker_device_id        TEXT REFERENCES tracker_devices(id) ON DELETE SET NULL,
  status                   TEXT NOT NULL DEFAULT 'WAITING'
                             CHECK (status IN ('WAITING','IN_PROGRESS','FINISHED','INTERRUPTED')),
  started_at               TIMESTAMPTZ,
  finished_at              TIMESTAMPTZ,
  finish_reason            TEXT,
  pending_points_reported  INT NOT NULL DEFAULT 0,
  points_count             INT NOT NULL DEFAULT 0,
  accepted_points          INT NOT NULL DEFAULT 0,
  last_point_captured_at   TIMESTAMPTZ,
  last_point_received_at   TIMESTAMPTZ,
  last_lat                 DOUBLE PRECISION,
  last_lng                 DOUBLE PRECISION,
  last_accuracy_m          REAL,
  -- Distância do percurso válido (recalculada pelo servidor; a fonte continua sendo gps_points)
  distance_m               DOUBLE PRECISION NOT NULL DEFAULT 0,
  valid_points             INT NOT NULL DEFAULT 0,
  stats_updated_at         TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX tracking_sessions_campaign_idx ON tracking_sessions (campaign_id);
CREATE INDEX tracking_sessions_store_time_idx ON tracking_sessions (store_id, started_at DESC);
CREATE INDEX tracking_sessions_user_idx ON tracking_sessions (user_id, status);

-- Pontos GPS brutos. Nada é apagado nem corrigido: pontos impossíveis ficam marcados como recusados,
-- e a qualidade (precisão, saltos) é tratada na análise, para poder recalcular depois.
CREATE TABLE gps_points (
  id               BIGSERIAL PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES tracking_sessions(id) ON DELETE RESTRICT,
  client_point_id  TEXT NOT NULL,
  lat              DOUBLE PRECISION NOT NULL,
  lng              DOUBLE PRECISION NOT NULL,
  accuracy_m       REAL,
  altitude_m       REAL,
  speed_mps        REAL,
  heading_deg      REAL,
  captured_at      TIMESTAMPTZ NOT NULL,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted         BOOLEAN NOT NULL,
  reject_reason    TEXT,
  UNIQUE (session_id, client_point_id)
);
CREATE INDEX gps_points_session_time_idx ON gps_points (session_id, captured_at);

CREATE TABLE coverage_results (
  id                   TEXT PRIMARY KEY,
  campaign_id          TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  computed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  computed_by          TEXT,
  methodology_version  TEXT NOT NULL,
  params               JSONB NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('OK','INCONCLUSIVE','NO_DATA','NO_PLAN')),
  planned_length_m     DOUBLE PRECISION NOT NULL DEFAULT 0,
  covered_length_m     DOUBLE PRECISION NOT NULL DEFAULT 0,
  percent              DOUBLE PRECISION,
  streets              JSONB NOT NULL DEFAULT '[]'::jsonb,
  valid_points         INT NOT NULL DEFAULT 0,
  total_points         INT NOT NULL DEFAULT 0,
  sessions_count       INT NOT NULL DEFAULT 0,
  distance_m           DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE INDEX coverage_results_campaign_idx ON coverage_results (campaign_id, computed_at DESC);
