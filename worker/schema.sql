-- La Grieta del Persa · esquema de base de datos (Cloudflare D1 / SQLite)
-- Ejecutar una sola vez:  npx wrangler d1 execute persa --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  avatar        TEXT,
  twitch_id     TEXT UNIQUE,
  twitch_login  TEXT,
  kick_id       TEXT UNIQUE,
  kick_username TEXT,
  balance       INTEGER NOT NULL DEFAULT 0,   -- cache: siempre = SUM(ledger.delta)
  total_won     INTEGER NOT NULL DEFAULT 0,
  picks_won     INTEGER NOT NULL DEFAULT 0,
  picks_total   INTEGER NOT NULL DEFAULT 0,
  banned        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT,
  kind       TEXT NOT NULL,          -- 'user' | 'admin'
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state      TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Cada movimiento de fichas es una fila. Nunca se edita: el saldo sale de la suma.
CREATE TABLE IF NOT EXISTS ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  delta      INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  ref        TEXT UNIQUE,            -- evita acreditar dos veces lo mismo
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id);
CREATE INDEX IF NOT EXISTS ledger_created ON ledger(created_at);

-- Canjes de puntos de canal hechos por gente que todavía no se registró
CREATE TABLE IF NOT EXISTS pending_credits (
  ref              TEXT PRIMARY KEY,
  platform         TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  platform_name    TEXT,
  fichas           INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  claimed_by       TEXT
);
CREATE INDEX IF NOT EXISTS pending_lookup ON pending_credits(platform, platform_user_id);

CREATE TABLE IF NOT EXISTS inventory (
  user_id TEXT NOT NULL,
  item    TEXT NOT NULL,
  qty     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, item)
);

CREATE TABLE IF NOT EXISTS games (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,       -- 'app' | 'riot'
  status        TEXT NOT NULL,       -- 'live' | 'ending' | 'ended'
  champion      TEXT,
  champion_key  TEXT,
  team          TEXT,
  game_mode     TEXT,
  game_time     REAL DEFAULT 0,
  start_epoch   INTEGER,
  kills         INTEGER DEFAULT 0,
  deaths        INTEGER DEFAULT 0,
  assists       INTEGER DEFAULT 0,
  cs            INTEGER DEFAULT 0,
  result        TEXT,                -- 'win' | 'loss' | 'void'
  last_event_id INTEGER DEFAULT -1,
  players       TEXT,
  match_id      TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  ended_at      INTEGER
);
CREATE INDEX IF NOT EXISTS games_status ON games(status);

CREATE TABLE IF NOT EXISTS markets (
  id          TEXT PRIMARY KEY,
  game_id     TEXT,
  kind        TEXT NOT NULL,
  grp         TEXT NOT NULL,         -- 'partida' | 'primeros' | 'especial'
  question    TEXT NOT NULL,
  options     TEXT NOT NULL,         -- JSON [{key,label}]
  line        REAL,
  base        INTEGER NOT NULL,
  status      TEXT NOT NULL,         -- 'open' | 'resolved' | 'void'
  closes_at   INTEGER NOT NULL,
  close_gt    REAL,                  -- segundo de juego en que cierra (sigue al reloj del juego, pausas incluidas)
  outcome     TEXT,
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER,
  sort        INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS markets_game ON markets(game_id);
CREATE INDEX IF NOT EXISTS markets_status ON markets(status);

CREATE TABLE IF NOT EXISTS picks (
  id         TEXT PRIMARY KEY,
  market_id  TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  option     TEXT NOT NULL,
  odds       REAL NOT NULL,
  boost      TEXT,
  payout     INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',   -- pending | won | lost | void
  created_at INTEGER NOT NULL,
  UNIQUE (market_id, user_id)
);
CREATE INDEX IF NOT EXISTS picks_user ON picks(user_id);

CREATE TABLE IF NOT EXISTS rewards (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  cost        INTEGER NOT NULL,
  stock       INTEGER,               -- NULL = ilimitado
  icon        TEXT,
  needs_note  INTEGER DEFAULT 0,
  note_hint   TEXT,
  active      INTEGER DEFAULT 1,
  sort        INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  reward_id   TEXT,
  reward_name TEXT NOT NULL,
  cost        INTEGER NOT NULL,
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'pendiente',  -- pendiente | cumplido | devuelto
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status);

-- Actividad pública (alimenta el feed de la web y las alertas del overlay)
CREATE TABLE IF NOT EXISTS feed (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  text       TEXT NOT NULL,
  user_name  TEXT,
  amount     INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seen_messages (
  id         TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
