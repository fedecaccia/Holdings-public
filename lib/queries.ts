import { q } from './db'

export type Holding = {
  asset_id: string
  key: string
  symbol: string
  name: string
  category: string
  subtype: string | null
  account: string
  currency: string
  price_source: string
  quantity: number
  price: number | null
  value_usd: number
  cost_usd: number | null
  apr: number | null
  stale: boolean
  date: string
  meta: Record<string, unknown>
}

/** Las tenencias al último día con snapshot. */
export async function latestHoldings(): Promise<Holding[]> {
  const rows = await q<Record<string, unknown>>(
    `WITH last AS (SELECT MAX(date) AS d FROM daily_snapshots)
     SELECT s.id AS asset_id, s.key, s.symbol, s.name, ds.category, s.subtype, a.name AS account, ds.currency,
            s.price_source, ds.quantity::float8 AS quantity, ds.price::float8 AS price, ds.value_usd::float8 AS value_usd,
            ds.cost_usd::float8 AS cost_usd, ds.apr::float8 AS apr, ds.stale, ds.date::text AS date, s.meta
     FROM daily_snapshots ds JOIN last ON ds.date = last.d
     JOIN assets s ON s.id = ds.asset_id JOIN accounts a ON a.id = s.account_id
     ORDER BY ds.value_usd DESC`,
  )
  return rows as unknown as Holding[]
}

/** Deudas en cuotas: se exponen las cuotas pagas, las que faltan y la última cuota pagada, los mismos datos con
    los que el cierre calcula la deuda (lib/sync.ts), para que quien lea la API no tenga que deducirlos. */
export async function withInstallments(holdings: Holding[]): Promise<Holding[]> {
  const debts = holdings.filter((h) => h.price_source === 'debt' && h.meta?.total_installments != null)
  if (debts.length) {
    const paid = new Map(
      (
        await q<{ asset_id: string; paid: number; last_ars: number | null; last_date: string | null }>(
          `SELECT asset_id::text, COUNT(*)::int AS paid,
                  (ARRAY_AGG(amount ORDER BY date DESC) FILTER (WHERE currency = 'ARS'))[1]::float8 AS last_ars,
                  MAX(date)::text AS last_date
           FROM cash_flows WHERE kind = 'cuota' AND date <= $1 GROUP BY asset_id`,
          [debts[0]!.date],
        )
      ).map((r) => [r.asset_id, r]),
    )
    for (const h of debts) {
      const linked = typeof h.meta.linked_asset_id === 'string' ? h.meta.linked_asset_id : h.asset_id
      const p = paid.get(linked)
      const total = Number(h.meta.total_installments)
      h.meta = {
        ...h.meta,
        paid_installments: p?.paid ?? 0,
        remaining_installments: Math.max(total - (p?.paid ?? 0), 0),
        last_installment_ars: p?.last_ars ?? h.meta.reference_installment_ars ?? null,
        last_installment_date: p?.last_date ?? null,
      }
    }
  }
  return holdings
}

/** Activos sin snapshot todavía (por ejemplo recién cargados por la API), para mostrarlos en el listado. */
export async function allAssets() {
  return q<{ id: string; key: string; symbol: string; name: string; category: string; price_source: string; account: string; quantity: number }>(
    `SELECT s.id, s.key, s.symbol, s.name, s.category, s.price_source, a.name AS account,
            COALESCE((SELECT SUM(delta) FROM quantity_deltas d WHERE d.asset_id = s.id), 0)::float8 AS quantity
     FROM assets s JOIN accounts a ON a.id = s.account_id WHERE s.active ORDER BY s.category, s.name`,
  )
}

export type Point = { date: string; value: number; cost: number | null }

export async function totalSeries(): Promise<Point[]> {
  return q<Point>(
    `SELECT date::text, SUM(value_usd)::float8 AS value, SUM(cost_usd)::float8 AS cost
     FROM daily_snapshots GROUP BY date ORDER BY date`,
  )
}

export async function categorySeries(category?: string): Promise<(Point & { category: string })[]> {
  return q<Point & { category: string }>(
    `SELECT date::text, category, SUM(value_usd)::float8 AS value, SUM(cost_usd)::float8 AS cost
     FROM daily_snapshots ${category ? 'WHERE category = $1' : ''} GROUP BY date, category ORDER BY date`,
    category ? [category] : [],
  )
}

export async function assetSeries(assetId: string) {
  return q<Point & { quantity: number; price: number | null; apr: number | null }>(
    `SELECT date::text, value_usd::float8 AS value, cost_usd::float8 AS cost, quantity::float8 AS quantity,
            price::float8 AS price, apr::float8 AS apr
     FROM daily_snapshots WHERE asset_id = $1 ORDER BY date`,
    [assetId],
  )
}

export async function assetDetail(assetId: string) {
  const [asset] = await q<Record<string, unknown>>(
    `SELECT s.*, a.name AS account FROM assets s JOIN accounts a ON a.id = s.account_id WHERE s.id = $1`,
    [assetId],
  )
  const deltas = await q<{ date: string; delta: number; unit_price: number | null; source: string; note: string | null }>(
    `SELECT date::text, delta::float8 AS delta, unit_price::float8 AS unit_price, source, note
     FROM quantity_deltas WHERE asset_id = $1 ORDER BY date DESC, created_at DESC LIMIT 50`,
    [assetId],
  )
  const flows = await q<{ date: string; kind: string; amount: number; currency: string; amount_usd: number; note: string | null }>(
    `SELECT date::text, kind, amount::float8 AS amount, currency, amount_usd::float8 AS amount_usd, note
     FROM cash_flows WHERE asset_id = $1 ORDER BY date DESC LIMIT 50`,
    [assetId],
  )
  const events = await q<{ date: string; kind: string; amount: number | null; currency: string | null; note: string | null }>(
    `SELECT date::text, kind, amount::float8 AS amount, currency, note FROM asset_events
     WHERE asset_id = $1 ORDER BY date DESC LIMIT 50`,
    [assetId],
  )
  return { asset, deltas, flows, events }
}

export async function upcomingEvents(limit = 10) {
  return q<{ date: string; kind: string; amount: number | null; currency: string | null; symbol: string; asset_id: string }>(
    `SELECT e.date::text, e.kind, e.amount::float8 AS amount, e.currency, s.symbol, s.id AS asset_id
     FROM asset_events e JOIN assets s ON s.id = e.asset_id
     WHERE e.date >= CURRENT_DATE - 1 ORDER BY e.date LIMIT $1`,
    [limit],
  )
}

export async function lastSyncRuns() {
  return q<{ date: string; source: string; status: string; detail: string | null; started_at: string }>(
    `SELECT date::text, source, status, detail, started_at::text FROM sync_runs
     WHERE started_at > now() - interval '3 days' ORDER BY started_at DESC LIMIT 40`,
  )
}

export async function latestFx() {
  const rows = await q<{ type: string; ars_per_usd: number; date: string }>(
    `SELECT DISTINCT ON (type) type, ars_per_usd::float8 AS ars_per_usd, date::text FROM fx_rates ORDER BY type, date DESC`,
  )
  return Object.fromEntries(rows.map((r) => [r.type, r]))
}

export type FlowItem = {
  month: string
  asset_id: string
  name: string
  category: string
  account: string
  subtype: string | null
  meta: Record<string, unknown>
  income: number
  expense: number
  days: number
  avg_value: number
  avg_quantity: number
  min_apr: number | null
  max_apr: number | null
  avg_apr: number | null
}

/** Detalle del historial de /flujo: lo devengado por activo en cada mes, y el total de cada día. */
export async function monthlyFlowDetail() {
  const [items, days] = await Promise.all([
    q<FlowItem>(
      `SELECT to_char(ds.date, 'YYYY-MM') AS month, s.id AS asset_id, s.name, ds.category, a.name AS account, s.subtype, s.meta,
              SUM(ds.flow_in_usd)::float8 AS income, SUM(ds.flow_out_usd)::float8 AS expense,
              -- Solo los días que devengaron: así saldo × APR ÷ 365 × días da el monto que se muestra.
              COUNT(*) FILTER (WHERE ds.flow_in_usd > 0 OR ds.flow_out_usd > 0)::int AS days,
              AVG(ds.value_usd) FILTER (WHERE ds.flow_in_usd > 0)::float8 AS avg_value,
              AVG(ds.quantity) FILTER (WHERE ds.flow_in_usd > 0)::float8 AS avg_quantity,
              MIN(ds.apr) FILTER (WHERE ds.flow_in_usd > 0)::float8 AS min_apr, MAX(ds.apr) FILTER (WHERE ds.flow_in_usd > 0)::float8 AS max_apr,
              AVG(ds.apr) FILTER (WHERE ds.flow_in_usd > 0)::float8 AS avg_apr
       FROM daily_snapshots ds JOIN assets s ON s.id = ds.asset_id JOIN accounts a ON a.id = s.account_id
       WHERE ds.flow_in_usd IS NOT NULL AND ds.date >= date_trunc('month', CURRENT_DATE) - interval '35 months'
       GROUP BY 1, s.id, s.name, ds.category, a.name, s.subtype, s.meta
       HAVING SUM(ds.flow_in_usd) > 0 OR SUM(ds.flow_out_usd) > 0`,
    ),
    q<{ date: string; income: number; expense: number }>(
      `SELECT date::text, SUM(flow_in_usd)::float8 AS income, SUM(flow_out_usd)::float8 AS expense
       FROM daily_snapshots WHERE flow_in_usd IS NOT NULL AND date >= date_trunc('month', CURRENT_DATE) - interval '35 months'
       GROUP BY date ORDER BY date DESC`,
    ),
  ])
  return { items, days }
}

export type ChangeRow = {
  asset_id: string
  symbol: string
  name: string
  category: string
  subtype: string | null
  account: string
  currency: string
  price_source: string
  meta: Record<string, unknown>
  stale: boolean
  q0: number | null
  p0: number | null
  v0: number | null
  q1: number | null
  p1: number | null
  v1: number | null
}

/** Cada activo en los dos últimos cierres (de un lado puede faltar: activo nuevo o que dejó de estar). */
export async function lastTwoCloses() {
  const rows = await q<ChangeRow & { d0: string | null; d1: string }>(
    `WITH d AS (SELECT date FROM daily_snapshots GROUP BY date ORDER BY date DESC LIMIT 2),
          d1 AS (SELECT MAX(date) AS d FROM d), d0 AS (SELECT MIN(date) AS d FROM d WHERE date < (SELECT d FROM d1)),
          cur AS (SELECT ds.* FROM daily_snapshots ds, d1 WHERE ds.date = d1.d),
          prev AS (SELECT ds.* FROM daily_snapshots ds, d0 WHERE ds.date = d0.d)
     SELECT s.id AS asset_id, s.symbol, s.name, COALESCE(cur.category, prev.category) AS category, s.subtype, a.name AS account,
            COALESCE(cur.currency, prev.currency) AS currency, s.price_source, s.meta, COALESCE(cur.stale, false) AS stale,
            prev.quantity::float8 AS q0, prev.price::float8 AS p0, prev.value_usd::float8 AS v0,
            cur.quantity::float8 AS q1, cur.price::float8 AS p1, cur.value_usd::float8 AS v1,
            (SELECT d::text FROM d0) AS d0, (SELECT d::text FROM d1) AS d1
     FROM cur FULL JOIN prev ON prev.asset_id = cur.asset_id
     JOIN assets s ON s.id = COALESCE(cur.asset_id, prev.asset_id) JOIN accounts a ON a.id = s.account_id`,
  )
  return { rows: rows as ChangeRow[], from: rows[0]?.d0 ?? null, to: rows[0]?.d1 ?? null }
}

/** Variación de cada activo entre los dos últimos cierres, partida en efecto cantidad (unidades nuevas o retiradas, al precio
 *  USD del cierre anterior) y efecto precio (lo demás: mercado y, en lo que está en pesos, tipo de cambio); las dos suman la
 *  variación. Deudas y préstamos se guardan con cantidad 1: en la deuda la "cantidad" es el saldo en su moneda (el precio del
 *  snapshot), así una cuota paga es cantidad y el dólar es precio; en el préstamo todo es interés devengado, o sea cantidad. */
export async function dailyChange() {
  const { rows, from, to } = await lastTwoCloses()
  const data = rows.map((r) => {
    const v0 = r.v0 ?? 0
    const v1 = r.v1 ?? 0
    const change = v1 - v0
    const [u0, u1] = r.price_source === 'debt' ? [r.p0, r.p1] : r.price_source === 'loan' ? [r.v0, r.v1] : [r.q0, r.q1]
    const unit = u0 && r.v0 !== null && u1 !== null ? r.v0 / u0 : null
    const byQty = unit !== null ? (u1! - u0!) * unit : change
    return { ...r, v0, v1, change, byQty, byPrice: change - byQty }
  })
  return { rows: data, from, to }
}
