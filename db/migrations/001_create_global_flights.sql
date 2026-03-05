BEGIN;

CREATE TABLE IF NOT EXISTS global_flights (
  flight_id TEXT PRIMARY KEY,

  airline_id TEXT NOT NULL,
  flight_number TEXT,
  aircraft_type TEXT,

  origin CHAR(4),
  destination CHAR(4),

  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  altitude INTEGER,
  heading INTEGER,
  ground_speed INTEGER,

  dep_time BIGINT,
  arr_time BIGINT,

  status SMALLINT NOT NULL DEFAULT 1,

  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_global_flights_lat_lng
ON global_flights (latitude, longitude);

CREATE INDEX IF NOT EXISTS idx_global_flights_airline
ON global_flights (airline_id);

CREATE INDEX IF NOT EXISTS idx_global_flights_updated
ON global_flights (updated_at);

COMMIT;
