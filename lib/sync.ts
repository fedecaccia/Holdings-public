import { q } from './db'
import { todayAR } from './dates'
import { bondYield, type BondTerms } from './bonds'
import { dailyFromMonthly, monthlyFlow } from './cashflow'
import { fillMissingCosts } from './costs'
import { applyAssetMeta, applyOwnerConfig, isEmpty } from './owner-config'
import { fetchCoingecko } from './sources/coingecko'
import { fetchFx } from './sources/fx'
import { fetchIbkr } from './sources/ibkr'
import { fetchIol } from './sources/iol'
import { fetchMapleApy } from './sources/maple'
import type { SourcePosition, SourceResult } from './sources/types'
import { fetchAlchemyWallet, fetchWallet, sleep, ZERION_SPACING_MS, type Wallet } from './sources/wallets'

const SOURCES_BUDGET_MS = 600_000

function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('sin tiempo: no terminó dentro del cierre')), Math.max(deadline - Date.now(), 0))
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

type RunLog = { source: string; status: 'ok' | 'error' | 'skipped'; detail: string | null }

/**
 * El cierre del día. Un solo proceso: FX → fuentes automáticas → ajuste de cantidades
 * → precios → un único insert de snapshots. Si una fuente falla, sus activos repiten
 * el precio anterior y quedan `stale`: nunca se escribe cero por una caída.
 */
export async function runDailySync(options: { date?: string; fetchSources?: boolean; skipZerion?: boolean } = {}) {
  const date = options.date ?? todayAR()
  const fetchSources = options.fetchSources ?? true
  const logs: RunLog[] = []

  // 0. Base recién creada: cargar la configuración de db/owner-config.json (wallets, inmuebles, etc.).
  if (await isEmpty()) await applyOwnerConfig()

  // 1. FX
  const fx = await fetchFx()
  if (fx.cripto !== null) {
    await q(
      `INSERT INTO fx_rates (date, type, ars_per_usd) VALUES ($1, 'cripto', $2)
       ON CONFLICT (date, type) DO UPDATE SET ars_per_usd = EXCLUDED.ars_per_usd`,
      [date, fx.cripto],
    )
  }
  if (fx.mep !== null) {
    await q(
      `INSERT INTO fx_rates (date, type, ars_per_usd) VALUES ($1, 'mep', $2)
       ON CONFLICT (date, type) DO UPDATE SET ars_per_usd = EXCLUDED.ars_per_usd`,
      [date, fx.mep],
    )
  }
  logs.push({ source: 'fx', status: fx.cripto !== null ? 'ok' : 'error', detail: fx.cripto === null ? 'sin dólar cripto, se usa el último' : null })

  // 2. Fuentes automáticas
  const fresh = new Map<string, SourcePosition>()
  if (fetchSources) {
    const results: SourceResult[] = []
    // Vercel corta la función a los 800 s (maxDuration) y entonces no se escribe nada. Las fuentes tienen un presupuesto
    // de tiempo: la que no termina a tiempo se registra como error y sus activos quedan stale.
    const deadline = Date.now() + SOURCES_BUDGET_MS
    // Una fuente que falla se reintenta una vez al final (20 s después); solo se registra el resultado final.
    const failed: { source: string; fn: () => Promise<SourceResult> }[] = []
    const tryRun = async (source: string, enabled: boolean, fn: () => Promise<SourceResult>, retry = false) => {
      if (!enabled) return logs.push({ source, status: 'skipped', detail: 'sin credenciales' })
      if (Date.now() >= deadline) return logs.push({ source, status: 'error', detail: 'sin tiempo: no se llegó a consultar' })
      const started = Date.now()
      const secs = () => `${Math.round((Date.now() - started) / 1000)} s`
      try {
        const r = await withDeadline(fn(), deadline)
        results.push(r)
        logs.push({ source, status: 'ok', detail: `${r.positions.length} posiciones${r.note ? ` ${r.note}` : ''}${retry ? ' (reintento)' : ''}, ${secs()}` })
      } catch (error) {
        console.log('[sync]', source, 'falló', secs(), (error as Error).message.slice(0, 200))
        if (!retry && Date.now() < deadline) return failed.push({ source, fn })
        return logs.push({ source, status: 'error', detail: `${(error as Error).message.slice(0, 480)} (${secs()})` })
      }
      console.log('[sync]', source, 'ok', secs())
    }
    // IBKR pasa casi todo el tiempo esperando que el statement esté listo: corre en paralelo con el resto.
    const ibkr = tryRun('ibkr', Boolean(process.env.IBKR_FLEX_TOKEN), fetchIbkr)
    await tryRun('iol', Boolean(process.env.IOL_USERNAME), fetchIol)

    const wallets = await q<{ key: string; name: string; provider: string; address: string }>(
      `SELECT key, name, provider, address FROM accounts
       WHERE active AND address IS NOT NULL AND provider IN ('zerion','btc','near','mvx') ORDER BY key`,
    )
    // Si Zerion falla, la wallet se lee por Alchemy (lib/sources/wallets.ts, con ALCHEMY_API_KEY). Alchemy no pasa
    // a cero lo que no trae (accountKeys vacío): queda stale hasta que Zerion vuelva. Si Zerion dice que se agotó
    // la cuota del día o del mes, las wallets que faltan van directo a Alchemy. Un 429 por segundo se reintenta
    // normalmente. La wallet queda ok, pero se registra un error 'zerion': así corre el reintento de las 23:30 y,
    // si Zerion sigue caído, llega el aviso. skipZerion (POST /api/v1/sync) sirve para probar el respaldo.
    let zerionLimited = options.skipZerion ?? false
    const viaAlchemy: string[] = []
    let zerionReason = ''
    // Claves (y símbolo) con cantidad de cada wallet de Zerion: se leen una vez, solo si hace falta el respaldo.
    let known: Map<string, Map<string, string>> | null = null
    const knownKeys = async (account: string) => {
      if (known === null) {
        const rows = await q<{ account: string; key: string; symbol: string }>(
          `SELECT a.key AS account, s.key, s.symbol FROM assets s JOIN accounts a ON a.id = s.account_id
           JOIN quantity_deltas d ON d.asset_id = s.id
           WHERE a.provider = 'zerion' GROUP BY a.key, s.key, s.symbol HAVING SUM(d.delta) <> 0`,
        )
        known = new Map()
        for (const r of rows) known.set(r.account, (known.get(r.account) ?? new Map<string, string>()).set(r.key, r.symbol))
      }
      return known.get(account) ?? new Map<string, string>()
    }
    const alchemy = async (wallet: Wallet, source: string, reason: string): Promise<SourceResult> => {
      const why = reason.includes('cuota agotada') ? 'cuota agotada' : reason.slice(0, 120)
      try {
        const r = await fetchAlchemyWallet(wallet, await knownKeys(wallet.accountKey))
        viaAlchemy.push(wallet.name)
        zerionReason = why
        const note = `por Alchemy (Zerion: ${why})${r.failed.length > 0 ? `, sin leer: ${r.failed.join(', ')}` : ''}`
        return { source, accountKeys: [], positions: r.positions, note }
      } catch (error) {
        throw new Error(`Zerion: ${why} · respaldo: ${(error as Error).message}`)
      }
    }
    for (const w of wallets) {
      const source = `wallet:${w.name}`
      const wallet: Wallet = { accountKey: w.key, name: w.name, provider: w.provider, address: w.address }
      const isZerion = w.provider === 'zerion'
      if (isZerion && zerionLimited) {
        await tryRun(source, true, () => alchemy(wallet, source, options.skipZerion ? 'salteado' : 'cuota agotada'))
        continue
      }
      await tryRun(source, true, async () => {
        try {
          return { source, accountKeys: [w.key], positions: await fetchWallet(wallet) }
        } catch (error) {
          if (!isZerion) throw error
          const message = (error as Error).message
          if (message.includes('cuota agotada')) zerionLimited = true
          return alchemy(wallet, source, message)
        }
      })
      if (isZerion) await sleep(ZERION_SPACING_MS)
    }
    await ibkr
    // Lo que falló se reintenta una vez (si Zerion ya no tiene cuota, falla enseguida y va otra vez a Alchemy).
    if (failed.length > 0) {
      if (deadline - Date.now() > 40_000) await sleep(20_000)
      for (const f of failed) {
        await tryRun(f.source, true, f.fn, true)
        await sleep(ZERION_SPACING_MS)
      }
    }
    // Siempre que hubo wallets de Zerion queda una fila 'zerion': un cierre que sale bien pisa el error de uno anterior.
    if (viaAlchemy.length > 0) {
      logs.push({ source: 'zerion', status: 'error', detail: `${viaAlchemy.length} wallets por Alchemy (Zerion: ${zerionReason})` })
    } else if (wallets.some((w) => w.provider === 'zerion')) {
      logs.push({ source: 'zerion', status: 'ok', detail: null })
    }

    for (const r of results) {
      const merged = mergeByKey(r.positions)
      await persistPositions(date, r.accountKeys, merged)
      for (const p of merged) fresh.set(p.key, p)
    }
  }

  // 3. Lo que la fuente no trae (condiciones de ON, costos guardados en la config) y, para lo que todavía no
  // tiene valor de compra en USD, buscarlo una vez (ver lib/costs.ts).
  if (fetchSources) {
    await applyAssetMeta()
    try {
      logs.push({ source: 'costos', status: 'ok', detail: await fillMissingCosts() })
    } catch (error) {
      logs.push({ source: 'costos', status: 'error', detail: (error as Error).message.slice(0, 500) })
    }
  }

  // 4. Snapshots
  const written = await writeSnapshots(date, fresh, fx.cripto, fx.mep)

  await q(
    `INSERT INTO sync_runs (date, source, status, detail)
     SELECT $1, x.source, x.status, x.detail FROM jsonb_to_recordset($2::jsonb) AS x(source text, status text, detail text)`,
    [date, JSON.stringify(logs)],
  )
  console.log('[sync]', date, written, 'snapshots', JSON.stringify(logs))
  return { date, snapshots: written, logs }
}

function mergeByKey(positions: SourcePosition[]): SourcePosition[] {
  const byKey = new Map<string, SourcePosition>()
  for (const p of positions) {
    const prev = byKey.get(p.key)
    if (prev === undefined) byKey.set(p.key, { ...p })
    else prev.quantity = String(Number(prev.quantity) + Number(p.quantity))
  }
  return [...byKey.values()]
}

/** Crea cuentas y activos que falten y escribe el delta que lleva cada cantidad a lo que dice la fuente. */
async function persistPositions(date: string, accountKeys: string[], positions: SourcePosition[]) {
  const accounts = new Map<string, SourcePosition>()
  for (const p of positions) accounts.set(p.accountKey, p)
  if (accounts.size > 0) {
    await q(
      `INSERT INTO accounts (key, name, provider, sync, address)
       SELECT x.key, x.name, x.provider, 'auto', x.address
       FROM jsonb_to_recordset($1::jsonb) AS x(key text, name text, provider text, address text)
       ON CONFLICT (key) DO UPDATE SET sync = 'auto'`,
      [JSON.stringify([...accounts.values()].map((p) => ({ key: p.accountKey, name: p.accountName, provider: p.provider, address: p.address ?? null })))],
    )
  }

  if (positions.length > 0) {
    await q(
      `INSERT INTO assets (account_id, key, symbol, name, category, subtype, currency, price_source, price_ref, meta)
       SELECT a.id, x.key, x.symbol, x.name, x.category, x.subtype, x.currency, x.price_source, x.price_ref, x.meta
       FROM jsonb_to_recordset($1::jsonb) AS x(account_key text, key text, symbol text, name text, category text,
            subtype text, currency text, price_source text, price_ref text, meta jsonb)
       JOIN accounts a ON a.key = x.account_key
       ON CONFLICT (key) DO UPDATE SET
         symbol = EXCLUDED.symbol, name = EXCLUDED.name, currency = EXCLUDED.currency,
         price_source = EXCLUDED.price_source, price_ref = EXCLUDED.price_ref,
         -- Las wallets (Zerion) mandan su categoría y subtipo; en el resto se respeta lo que se haya cambiado a mano.
         category = CASE WHEN EXCLUDED.price_source = 'zerion' THEN EXCLUDED.category ELSE assets.category END,
         subtype = CASE WHEN EXCLUDED.price_source = 'zerion' THEN EXCLUDED.subtype ELSE assets.subtype END,
         meta = assets.meta || EXCLUDED.meta, active = true`,
      [
        JSON.stringify(
          positions.map((p) => ({
            account_key: p.accountKey,
            key: p.key,
            symbol: p.symbol,
            name: p.name,
            category: p.category,
            subtype: p.subtype ?? null,
            currency: p.currency,
            price_source: p.priceSource,
            price_ref: p.priceRef ?? null,
            meta: { ...(p.meta ?? {}), ...(p.avgCost ? { avg_cost: p.avgCost } : {}) },
          })),
        ),
      ],
    )
  }

  // Lo que la fuente ya no devuelve, para las cuentas que respondieron bien, quedó en cero.
  const targets = positions.map((p) => ({ key: p.key, quantity: p.quantity }))
  const seen = new Set(targets.map((t) => t.key))
  const existing = await q<{ key: string }>(
    `SELECT s.key FROM assets s JOIN accounts a ON a.id = s.account_id WHERE a.key = ANY($1::text[])`,
    [accountKeys],
  )
  for (const e of existing) if (!seen.has(e.key)) targets.push({ key: e.key, quantity: '0' })

  await q(
    `WITH x AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(key text, quantity numeric)),
     cur AS (
       SELECT s.id, s.key, COALESCE(SUM(d.delta), 0) AS qty, COUNT(d.id) AS n
       FROM assets s LEFT JOIN quantity_deltas d ON d.asset_id = s.id
       WHERE s.key IN (SELECT key FROM x) GROUP BY s.id, s.key
     )
     INSERT INTO quantity_deltas (asset_id, date, delta, source, note)
     SELECT cur.id, $2::date, x.quantity - cur.qty, CASE WHEN cur.n = 0 THEN 'onboarding' ELSE 'sync' END,
            'ajuste automático: cantidad informada por la fuente'
     FROM x JOIN cur ON cur.key = x.key
     WHERE x.quantity <> cur.qty`,
    [JSON.stringify(targets), date],
  )
}

type AssetRow = {
  id: string
  key: string
  symbol: string
  category: string
  currency: string
  price_source: string
  price_ref: string | null
  meta: Record<string, unknown>
  quantity: string
}

type SnapshotRow = {
  date: string
  asset_id: string
  category: string
  quantity: string
  price: number | null
  currency: string
  fx_ars_usd: number | null
  value_usd: number
  cost_usd: number | null
  apr: number | null
  stale: boolean
  flow_in_usd: number
  flow_out_usd: number
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

async function writeSnapshots(date: string, fresh: Map<string, SourcePosition>, fxToday: number | null, mepToday: number | null): Promise<number> {
  const lastFx = async (type: string) =>
    num((await q<{ ars_per_usd: string }>(
      `SELECT ars_per_usd FROM fx_rates WHERE type = $2 AND date <= $1 ORDER BY date DESC LIMIT 1`,
      [date, type],
    ))[0]?.ars_per_usd)
  const fx = fxToday ?? (await lastFx('cripto'))
  // Títulos que cotizan en pesos (CEDEARs, ON, acciones de IOL): valen lo que se obtiene vendiéndolos y pasando a
  // dólares por MEP, que es como se sale de ellos. El resto de los pesos (efectivo, cuotas) va al dólar cripto.
  const mep = mepToday ?? (await lastFx('mep')) ?? fx

  const assets = await q<AssetRow>(
    `SELECT s.id, s.key, s.symbol, s.category, s.currency, s.price_source, s.price_ref, s.meta,
            COALESCE((SELECT SUM(d.delta) FROM quantity_deltas d WHERE d.asset_id = s.id AND d.date <= $1), 0)::text AS quantity
     FROM assets s WHERE s.active`,
    [date],
  )

  const lastSnap = new Map(
    (
      await q<{ asset_id: string; date: string; price: string | null; quantity: string }>(
        `SELECT DISTINCT ON (asset_id) asset_id, date::text, price::text, quantity::text
         FROM daily_snapshots WHERE date < $1 ORDER BY asset_id, date DESC`,
        [date],
      )
    ).map((r) => [r.asset_id, r]),
  )

  const externalToday = new Map(
    (
      await q<{ asset_id: string; delta: string }>(
        `SELECT asset_id, SUM(delta)::text AS delta FROM quantity_deltas WHERE date = $1 AND source <> 'sync' GROUP BY asset_id`,
        [date],
      )
    ).map((r) => [r.asset_id, Number(r.delta)]),
  )

  const valuations = new Map(
    (
      await q<{ asset_id: string; value: string; currency: string }>(
        `SELECT DISTINCT ON (asset_id) asset_id, value::text, currency FROM manual_valuations
         WHERE date <= $1 ORDER BY asset_id, date DESC, created_at DESC`,
        [date],
      )
    ).map((r) => [r.asset_id, r]),
  )

  const flows = new Map(
    (
      await q<{ asset_id: string; invested_usd: string; last_cuota: string | null; cuotas: string }>(
        `SELECT asset_id,
                COALESCE(SUM(amount_usd) FILTER (WHERE kind IN ('cuota','aporte')), 0)::text AS invested_usd,
                (ARRAY_AGG(amount ORDER BY date DESC) FILTER (WHERE kind = 'cuota' AND currency = 'ARS'))[1]::text AS last_cuota,
                COUNT(*) FILTER (WHERE kind = 'cuota')::text AS cuotas
         FROM cash_flows WHERE date <= $1 GROUP BY asset_id`,
        [date],
      )
    ).map((r) => [r.asset_id, r]),
  )

  const cgIds = [...new Set(assets.filter((a) => a.price_source === 'coingecko' && a.price_ref).map((a) => a.price_ref!))]
  let cg = new Map<string, number>()
  try {
    cg = await fetchCoingecko(cgIds)
  } catch {
    // sin CoinGecko: esos activos repiten el último precio y quedan stale
  }

  // APR publicado por el protocolo, cuando existe (Maple). Si la API falla, se estima cierre a cierre como el resto.
  const isMapleUsdc = (a: AssetRow) => a.meta?.protocol === 'Maple' && /USDC/i.test(`${a.symbol} ${a.key}`)
  let mapleApy: number | null = null
  if (assets.some(isMapleUsdc)) {
    try {
      mapleApy = await fetchMapleApy()
    } catch {
      mapleApy = null
    }
  }

  const toUsd = (amount: number, currency: string): number | null =>
    currency === 'USD' ? amount : fx ? amount / fx : null

  // Deuda de cuotas en ARS: cuotas que faltan × última cuota pagada (o la cargada en meta), o su tasación manual.
  const debtArs = (d: AssetRow): { ars: number; currency: string } => {
    const m = d.meta ?? {}
    const v = valuations.get(d.id)
    if (v) return { ars: Number(v.value), currency: v.currency }
    // Las cuotas se cargan contra el inmueble (meta.linked_asset_id): suman a lo invertido y restan acá.
    const f = flows.get(typeof m.linked_asset_id === 'string' ? m.linked_asset_id : d.id)
    const remaining = (num(m.total_installments) ?? 0) - (num(f?.cuotas) ?? 0)
    const cuota = num(f?.last_cuota) ?? num(m.reference_installment_ars) ?? 0
    return { ars: Math.max(remaining, 0) * cuota, currency: 'ARS' }
  }

  const rows: SnapshotRow[] = []
  for (const a of assets) {
    const qty = Number(a.quantity)
    const meta = a.meta ?? {}
    const prev = lastSnap.get(a.id)
    let price: number | null = null
    let value: number | null = null
    let stale = false
    let cost: number | null = null

    switch (a.price_source) {
      case 'iol':
      case 'ibkr':
      case 'zerion': {
        if (qty === 0) continue
        const f = fresh.get(a.key)
        price = num(f?.price) ?? num(prev?.price)
        stale = f === undefined
        break
      }
      case 'coingecko': {
        if (qty === 0) continue
        const p = a.price_ref ? cg.get(a.price_ref) : undefined
        price = p ?? num(prev?.price)
        stale = p === undefined
        break
      }
      case 'stable':
        if (qty === 0) continue
        price = 1
        break
      case 'manual':
      case 'invested': {
        // Inmuebles y auto: el activo vale su tasación (última valuación manual, si no el precio de compra, si no
        // lo invertido). Lo aportado es dato interno: es el costo. Si se paga en cuotas, lo que falta pagar
        // también es costo, así el PnL compara tasación contra el precio total que va a terminar costando.
        const base = num(meta.invested_base_usd) ?? 0
        const invested = base + (num(flows.get(a.id)?.invested_usd) ?? 0)
        const v = valuations.get(a.id)
        const purchase = num(meta.purchase_value_usd)
        value = v ? toUsd(Number(v.value), v.currency) : purchase ?? (invested > 0 ? invested : null)
        const debt = assets.find((d) => d.price_source === 'debt' && d.meta?.linked_asset_id === a.id)
        const pending = debt ? toUsd(debtArs(debt).ars, debtArs(debt).currency) ?? 0 : 0
        cost = invested > 0 ? invested + pending : num(meta.cost_usd)
        if (value === null) continue
        rows.push(row(a, date, '1', null, fx, value, cost, null, false, fx))
        continue
      }
      case 'debt': {
        const { ars, currency } = debtArs(a)
        const usd = toUsd(ars, currency)
        if (usd === null) continue
        rows.push(row(a, date, '1', ars, fx, -usd, null, null, fx === null, fx))
        continue
      }
      case 'loan': {
        // Préstamo otorgado a interés simple: capital × (1 + tasa × días / 365), desde start_date.
        const principal = num(meta.principal_usd)
        const rate = num(meta.rate_annual) ?? 0
        const start = typeof meta.start_date === 'string' ? Date.parse(meta.start_date) : NaN
        if (principal === null || Number.isNaN(start)) continue
        const days = Math.max(0, (Date.parse(date) - start) / 86_400_000)
        value = principal * (1 + rate * (days / 365))
        rows.push(row(a, date, '1', null, null, value, principal, rate, false, fx))
        continue
      }
      default:
        continue
    }

    if (price === null) continue
    const native = qty * price
    const security = a.currency === 'ARS' && a.price_source === 'iol' && a.category !== 'cash'
    value = security ? (mep ? native / mep : null) : toUsd(native, a.currency)
    if (value === null) continue
    // Costo siempre en dólares de la compra: meta.cost_usd (total, cargado en la config o en Configuración) o el
    // precio promedio del broker cuando está en USD (IBKR, IOL EE.UU.). El promedio en pesos de IOL no sirve:
    // son pesos de otra época y el ratio del CEDEAR cambió, así que sin cost_usd no hay PnL.
    // Stablecoins y efectivo en dólares: se compraron a 1 por unidad.
    const avg = num(meta.avg_cost)
    const atPar = a.currency === 'USD' && (a.category === 'stablecoin' || a.category === 'cash')
    cost = num(meta.cost_usd) ?? (atPar ? qty : avg !== null && a.currency === 'USD' ? qty * avg : null)

    // APR: manual (Nexo) o estimado por crecimiento de cantidad (Aave, Maple…).
    // Dos formas de rendir: la cantidad crece (aTokens, depósitos) o crece el precio del token (syrupUSDC, sUSDe).
    // ON: su TIR de mercado con el precio de hoy en USD por 100 nominales y las condiciones de emisión (meta.bond).
    const bond = meta.bond as BondTerms | undefined
    const bondApr = bond && qty > 0 ? bondYield((value / qty) * 100, bond, date) : null
    let apr = num(meta.apr_manual) ?? (isMapleUsdc(a) ? mapleApy : bondApr)
    if (apr === null && meta.yield_mode && prev && Number(prev.quantity) > 0 && qty > 0) {
      const days = Math.max(1, Math.round((Date.parse(date) - Date.parse(prev.date)) / 86_400_000))
      const prevPrice = num(prev.price)
      const r =
        meta.yield_mode === 'price'
          ? prevPrice && prevPrice > 0 && !stale ? (price / prevPrice - 1) * (365 / days) : NaN
          : ((qty - (externalToday.get(a.id) ?? 0)) / Number(prev.quantity) - 1) * (365 / days)
      apr = Number.isFinite(r) && Math.abs(r) < 5 ? r : null
    }
    rows.push(row(a, date, a.quantity, price, a.currency === 'ARS' ? (security ? mep : fx) : null, value, cost, apr, stale, fx))
  }

  if (rows.length > 0) {
    await q(
      `INSERT INTO daily_snapshots (date, asset_id, category, quantity, price, currency, fx_ars_usd, value_usd, cost_usd, apr, stale, flow_in_usd, flow_out_usd)
       SELECT x.date, x.asset_id, x.category, x.quantity, x.price, x.currency, x.fx_ars_usd, x.value_usd, x.cost_usd, x.apr, x.stale, x.flow_in_usd, x.flow_out_usd
       FROM jsonb_to_recordset($1::jsonb) AS x(date date, asset_id uuid, category text, quantity numeric, price numeric,
            currency text, fx_ars_usd numeric, value_usd numeric, cost_usd numeric, apr numeric, stale boolean,
            flow_in_usd numeric, flow_out_usd numeric)
       ON CONFLICT (date, asset_id) DO UPDATE SET
         category = EXCLUDED.category, quantity = EXCLUDED.quantity, price = EXCLUDED.price, currency = EXCLUDED.currency,
         fx_ars_usd = EXCLUDED.fx_ars_usd, value_usd = EXCLUDED.value_usd, cost_usd = EXCLUDED.cost_usd,
         apr = EXCLUDED.apr, stale = EXCLUDED.stale,
         flow_in_usd = EXCLUDED.flow_in_usd, flow_out_usd = EXCLUDED.flow_out_usd
       -- Una corrida posterior con la fuente caída no pisa la foto buena de hoy con el precio de ayer.
       WHERE daily_snapshots.stale OR NOT EXCLUDED.stale`,
      [JSON.stringify(rows)],
    )
  }
  // Lo que hoy quedó en cero sale del snapshot del día.
  await q(
    `DELETE FROM daily_snapshots ds USING assets s
     WHERE ds.asset_id = s.id AND ds.date = $1 AND s.price_source IN ('iol','ibkr','zerion','coingecko','stable')
       AND COALESCE((SELECT SUM(d.delta) FROM quantity_deltas d WHERE d.asset_id = s.id AND d.date <= $1), 0) = 0`,
    [date],
  )
  return rows.length
}

function row(
  a: AssetRow,
  date: string,
  quantity: string,
  price: number | null,
  fx: number | null,
  valueUsd: number,
  cost: number | null,
  apr: number | null,
  stale: boolean,
  arsPerUsd: number | null,
): SnapshotRow {
  const flow = monthlyFlow({ category: a.category, quantity: Number(quantity), value_usd: valueUsd, apr, meta: a.meta ?? {} }, arsPerUsd)
  return {
    date,
    asset_id: a.id,
    category: a.category,
    quantity,
    price,
    currency: a.currency,
    fx_ars_usd: fx,
    value_usd: Math.round(valueUsd * 1e6) / 1e6,
    cost_usd: cost === null ? null : Math.round(cost * 1e6) / 1e6,
    apr,
    stale,
    // Lo devengado ese día según la misma regla del flujo de fondos mensual: el historial de /flujo suma esto.
    flow_in_usd: Math.round(dailyFromMonthly(flow.income) * 1e6) / 1e6,
    flow_out_usd: Math.round(dailyFromMonthly(flow.expense) * 1e6) / 1e6,
  }
}

