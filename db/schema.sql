-- Esquema completo de Holdings. Idempotente: el build lo corre en cada deploy.
-- Para cambiar una tabla existente, agregar un ALTER ... IF NOT EXISTS al final.

CREATE TABLE IF NOT EXISTS accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,          -- 'iol', 'ibkr', 'evm:0xabc', 'btc:bc1...', 'manual:inmuebles'
  name        text NOT NULL,
  provider    text NOT NULL,                 -- iol | ibkr | zerion | btc | near | mvx | manual
  sync        text NOT NULL DEFAULT 'manual',-- auto | manual
  address     text,
  active      boolean NOT NULL DEFAULT true,
  meta        jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id),
  key           text NOT NULL UNIQUE,        -- clave estable: 'iol:bcba:NVDA', 'zerion:0xabc:<position id>', 'manual:inmuebles:depto-centro'
  symbol        text NOT NULL,
  name          text NOT NULL,
  category      text NOT NULL,               -- stablecoin | crypto | defi | acciones | cedears | bonos_on | fci | cash | real_estate | vehiculo | otros | deuda
  subtype       text,
  currency      text NOT NULL DEFAULT 'USD', -- moneda del precio: USD | ARS
  price_source  text NOT NULL,               -- iol | ibkr | zerion | coingecko | stable | manual | invested | debt
  price_ref     text,                        -- id de CoinGecko, conid de IBKR, etc.
  meta          jsonb NOT NULL DEFAULT '{}', -- avg_cost, apr_manual, recurring_expense, recurring_income, purchase_value_usd, ...
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quantity_deltas (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id     uuid NOT NULL REFERENCES assets(id),
  date         date NOT NULL,
  delta        numeric(38,18) NOT NULL,
  unit_price   numeric(38,18),               -- opcional: precio al que se operó, en la moneda del activo
  source       text NOT NULL,                -- onboarding | api | sync
  external_id  text UNIQUE,                  -- idempotencia
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quantity_deltas_asset_date ON quantity_deltas (asset_id, date);

CREATE TABLE IF NOT EXISTS daily_snapshots (
  date        date NOT NULL,
  asset_id    uuid NOT NULL REFERENCES assets(id),
  category    text NOT NULL,
  quantity    numeric(38,18) NOT NULL,
  price       numeric(38,18),
  currency    text NOT NULL,
  fx_ars_usd  numeric(20,6),
  value_usd   numeric(24,6) NOT NULL,
  cost_usd    numeric(24,6),                 -- costo total conocido, para el PnL visual
  apr         numeric(12,6),                 -- APR del día (estimado o manual), en fracción: 0.05 = 5 %
  stale       boolean NOT NULL DEFAULT false,
  flow_in_usd  numeric(24,6),                -- flujo devengado del día (historial de /flujo)
  flow_out_usd numeric(24,6),
  PRIMARY KEY (date, asset_id)
);
CREATE INDEX IF NOT EXISTS daily_snapshots_asset ON daily_snapshots (asset_id, date);

CREATE TABLE IF NOT EXISTS cash_flows (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id     uuid NOT NULL REFERENCES assets(id),
  date         date NOT NULL,
  kind         text NOT NULL,                -- cuota | expensas | alquiler | impuesto | aporte | otro
  amount       numeric(24,6) NOT NULL,
  currency     text NOT NULL,
  fx_ars_usd   numeric(20,6),
  amount_usd   numeric(24,6) NOT NULL,
  external_id  text UNIQUE,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cash_flows_asset ON cash_flows (asset_id, date);

CREATE TABLE IF NOT EXISTS manual_valuations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id     uuid NOT NULL REFERENCES assets(id),
  date         date NOT NULL,
  value        numeric(24,6) NOT NULL,       -- valor TOTAL del activo (no unitario)
  currency     text NOT NULL,
  external_id  text UNIQUE,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS manual_valuations_asset ON manual_valuations (asset_id, date);

CREATE TABLE IF NOT EXISTS asset_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id     uuid NOT NULL REFERENCES assets(id),
  date         date NOT NULL,
  kind         text NOT NULL,                -- dividendo | cupon | amortizacion | otro
  amount       numeric(24,6),                -- por unidad, opcional
  currency     text,
  external_id  text UNIQUE,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS asset_events_asset ON asset_events (asset_id, date);

CREATE TABLE IF NOT EXISTS fx_rates (
  date         date NOT NULL,
  type         text NOT NULL,                -- cripto | mep
  ars_per_usd  numeric(20,6) NOT NULL,
  PRIMARY KEY (date, type)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at   timestamptz NOT NULL DEFAULT now(),
  date         date NOT NULL,
  source       text NOT NULL,
  status       text NOT NULL,                -- ok | error | skipped
  detail       text
);

-- Alertas de las rutinas de riesgos e insights (las escriben por POST /api/v1/alerts).
-- dedupe_key evita repetir la misma alerta; notified_at marca las que ya salieron por Telegram.
CREATE TABLE IF NOT EXISTS alerts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL,                -- riesgo | insight | fundamental (valuación mensual por empresa)
  severity     text NOT NULL,                -- baja | media | alta | critica
  asset_id     uuid REFERENCES assets(id),   -- el activo que tenés, si aplica
  symbol       text,                         -- ticker (sirve también para lo que todavía no tenés)
  title        text NOT NULL,
  body         text NOT NULL,
  action       text,                         -- vender | reducir | comprar | aumentar | mantener | vigilar | rebalancear
  sources      jsonb NOT NULL DEFAULT '[]',  -- [{"title": "...", "url": "https://..."}]
  dedupe_key   text NOT NULL UNIQUE,
  notified_at  timestamptz,
  deprecated_at     timestamptz,           -- una alerta queda vigente hasta que la rutina la depreca
  deprecated_reason text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alerts_kind_created ON alerts (kind, created_at DESC);

