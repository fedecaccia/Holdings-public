import { q } from './db'
import { API as IOL_API, token as iolToken } from './sources/iol'
import { getJson, sleep } from './sources/types'

// Valor de compra en USD de lo que no lo trae su fuente. Corre dentro del cierre diario, pero solo para activos
// sin meta.cost_usd: una vez calculado no se vuelve a pedir. Cada resultado queda con meta.cost_source y
// meta.cost_note para ver de dónde salió, y sale en el backup de GET /api/v1/owner-config (asset_meta).
//
// - CEDEARs y ON de IOL: compras y ventas de /operaciones, cada una al dólar de SU día (CCL para CEDEARs, MEP
//   para ON, de argentinadatos.com). Los tickers D/C son el mismo título liquidado en dólares (AAPLD = AAPL): en
//   ese caso el monto ya es USD. Un ticker que cambió de nombre trae sus operaciones viejas con el nombre anterior
//   (FB → META, ver RENAMED).
// - CEDEARs: el ratio cambia (Caja de Valores lo ajusta y los splits de la acción lo mueven), y la cantidad de
//   cada operación está en CEDEARs de ESE momento. Cada operación se pasa a CEDEARs de hoy comparando lo pagado
//   por CEDEAR con el precio de la acción en EE.UU. ese día (Yahoo, ajustado por splits): el cociente da el ratio
//   de entonces, y contra el de hoy da cuántos CEDEARs de hoy era cada uno (1, 2, 3, 1/2…). Así las ventas
//   descuentan la parte correcta y la cantidad que suman las operaciones se puede comparar con la tenencia.
//   Si no alcanzan (faltan compras en la historia de IOL), lo que falta se estima al costo promedio de lo conocido
//   y se marca con meta.cost_gap (diferencia en CEDEARs de hoy; negativa si sobran). Sin precio de EE.UU. no se guarda nada y se reintenta.
// - Cada operación queda en meta.cost_ops para poder auditarla.
// - BTC: cada entrada a la address, al precio del día del bloque (mempool.space historical-price).

type Asset = {
  id: string
  key: string
  symbol: string
  category: string
  currency: string
  address: string | null
  meta: Record<string, unknown>
  quantity: number | null
  last_date: string | null
  last_price: number | null
}
type Op = { numero: number; tipo: string; simbolo?: string; mercado?: string; fechaOperada?: string; fechaOrden?: string; cantidadOperada?: number; montoOperado?: number }
type FxPoint = { fecha: string; venta: number }
/** Una operación ya pasada a dólares: d fecha, t tipo, n cantidad operada, ars/usd montos, fx dólar usado, us precio de
 *  la acción en EE.UU. ese día, x CEDEARs de hoy por cada CEDEAR operado. */
type CostOp = { d: string; t: string; n: number; ars: number | null; fx: number; usd: number; us?: number; x?: number }
type Cost = { usd: number; note: string; ops: CostOp[]; gap: number | null }
/** Resultado de IOL: costos encontrados y CEDEARs que se reintentan al día siguiente (sin precio de EE.UU.). */
type IolResult = { costs: Map<string, Cost>; retry: Set<string> }

/** Sube cuando cambia la cuenta: los costos de IOL calculados con una versión anterior se recalculan una vez. */
export const COST_VERSION = 2

/** Tickers que cambiaron de nombre: las operaciones anteriores al cambio vienen con el símbolo viejo. */
const RENAMED: Record<string, string[]> = { META: ['FB'] }

async function fxHistory(casa: 'bolsa' | 'contadoconliqui'): Promise<FxPoint[]> {
  const rows = (await getJson(`https://api.argentinadatos.com/v1/cotizaciones/dolares/${casa}`)) as FxPoint[]
  return rows.filter((r) => r.venta > 0).sort((a, b) => a.fecha.localeCompare(b.fecha))
}

/** Valor del día o, si ese día no hubo, el último anterior (hasta 7 días). */
function fxOn(points: FxPoint[], day: string): number | null {
  let best: FxPoint | null = null
  for (const p of points) {
    if (p.fecha > day) break
    best = p
  }
  if (!best) return null
  return (Date.parse(day) - Date.parse(best.fecha)) / 86_400_000 <= 7 ? best.venta : null
}

/** Cierres diarios de la acción en EE.UU., ajustados por splits (Yahoo los ajusta en `close`). */
async function usCloses(ticker: string, from: string): Promise<FxPoint[]> {
  const p1 = Math.floor(Date.parse(from) / 1000) - 10 * 86_400
  const p2 = Math.floor(Date.now() / 1000)
  type Chart = { chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[] } }[] } }
  const body = (await getJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${p1}&period2=${p2}&interval=1d`,
    { headers: { 'user-agent': 'Mozilla/5.0' } },
  )) as Chart
  const r = body.chart?.result?.[0]
  const ts = r?.timestamp ?? []
  const close = r?.indicators?.quote?.[0]?.close ?? []
  return ts
    .map((t, i) => ({ fecha: new Date(t * 1000).toISOString().slice(0, 10), venta: Number(close[i]) }))
    .filter((p) => p.venta > 0)
}

/** El ticker de la operación corresponde al de la tenencia: AAPLD/AAPLC → AAPL; FB → META. */
function matches(opSymbol: string, holding: string): boolean {
  const o = opSymbol.toUpperCase()
  const h = holding.toUpperCase()
  for (const name of [h, ...(RENAMED[h] ?? [])]) {
    if (o === name || o === `${name}D` || o === `${name}C`) return true
  }
  return h.endsWith('O') && (o === `${h.slice(0, -1)}D` || o === `${h.slice(0, -1)}C`)
}

/** Cocientes que puede tener un cambio de ratio (y sus inversos): los de Caja de Valores y los splits habituales. */
const STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 24, 25, 30, 40, 50].flatMap((m) => (m === 1 ? [1] : [m, 1 / m]))

/** Factor entre CEDEARs de entonces y de hoy llevado al cociente real más cercano, o null si ninguno queda a menos de
 *  12 % (el precio o el dólar de ese día no cierran). */
function ratioStep(f: number): number | null {
  if (!(f > 0)) return null
  const best = STEPS.reduce((a, b) => (Math.abs(Math.log(f / b)) < Math.abs(Math.log(f / a)) ? b : a))
  return Math.abs(f / best - 1) <= 0.12 ? best : null
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d

async function iolCosts(assets: Asset[]): Promise<IolResult> {
  const out = new Map<string, Cost>()
  const retry = new Set<string>()
  if (assets.length === 0) return { costs: out, retry }
  const auth = { headers: { authorization: `Bearer ${await iolToken()}` } }
  const today = new Date().toISOString().slice(0, 10)
  const ops = (await getJson(
    `${IOL_API}/api/v2/operaciones?filtro.fechaDesde=2010-01-01&filtro.fechaHasta=${today}&filtro.estado=terminadas`,
    auth,
    60_000,
  )) as Op[]
  if (!Array.isArray(ops)) throw new Error('IOL /operaciones cambió de forma')
  const [mep, ccl] = await Promise.all([fxHistory('bolsa'), fxHistory('contadoconliqui')])

  for (const a of assets) {
    const mine = ops
      .filter((o) => (o.tipo === 'Compra' || o.tipo === 'Venta') && o.simbolo && matches(o.simbolo, a.symbol))
      .filter((o) => !o.mercado || o.mercado.toLowerCase() === String(a.meta.market ?? 'bcba').toLowerCase())
      .sort((x, y) => String(x.fechaOperada ?? x.fechaOrden).localeCompare(String(y.fechaOperada ?? y.fechaOrden)))
    if (mine.length === 0) continue
    const cedear = a.category === 'cedears'
    const points = cedear ? ccl : mep

    // Ratio de hoy: precio de la acción en EE.UU. sobre lo que vale un CEDEAR en dólares (último cierre).
    let us: FxPoint[] = []
    let ratioNow: number | null = null
    if (cedear && a.last_date && a.last_price) {
      try {
        const first = mine[0]!
        us = await usCloses(String(a.meta.us_ticker ?? a.symbol), String(first.fechaOperada ?? first.fechaOrden).slice(0, 10))
        const usNow = fxOn(us, a.last_date)
        const fxNow = fxOn(ccl, a.last_date)
        if (usNow && fxNow) ratioNow = usNow / (a.last_price / fxNow)
      } catch {
        us = []
      }
    }
    // Sin el ratio de hoy no se puede pasar a CEDEARs de hoy: mejor reintentar mañana que guardar una cuenta a medias.
    if (cedear && !ratioNow) {
      retry.add(a.id)
      continue
    }

    const done: CostOp[] = []
    let qty = 0
    let usd = 0
    let skipped = 0
    let unmatched = 0
    for (const o of mine) {
      const day = String(o.fechaOperada ?? o.fechaOrden).slice(0, 10)
      const amount = Number(o.montoOperado ?? 0)
      const n = Number(o.cantidadOperada ?? 0)
      if (!(amount > 0) || !(n > 0)) {
        skipped++
        continue
      }
      // La moneda viene en null en la lista; el detalle la trae. Sin detalle, se infiere del sufijo D/C.
      let moneda: string | undefined
      try {
        moneda = ((await getJson(`${IOL_API}/api/v2/operaciones/${o.numero}`, auth)) as { moneda?: string }).moneda
      } catch {
        moneda = undefined
      }
      await sleep(250)
      const inUsd = moneda ? moneda === 'dolar_Estadounidense' : /[DC]$/.test(String(o.simbolo)) && !matches(String(o.simbolo), a.symbol.slice(0, -1))
      const fx = inUsd ? 1 : fxOn(points, day)
      if (fx === null) {
        skipped++
        continue
      }
      const opUsd = amount / fx
      const op: CostOp = { d: day, t: o.tipo, n, ars: inUsd ? null : amount, fx, usd: round(opUsd) }

      // CEDEARs de hoy que representa cada CEDEAR de esta operación.
      let x = 1
      const usThen = ratioNow ? fxOn(us, day) : null
      if (ratioNow && usThen) {
        const step = ratioStep(ratioNow / (usThen / (opUsd / n)))
        op.us = round(usThen)
        if (step === null) unmatched++
        else x = step
        op.x = step ?? undefined
      }
      const units = n * x
      if (o.tipo === 'Compra') {
        qty += units
        usd += opUsd
      } else if (qty > 0) {
        usd -= usd * Math.min(1, units / qty)
        qty = Math.max(0, qty - units)
      }
      done.push(op)
    }
    if (usd > 0) {
      const held = a.quantity ?? 0
      // Si las operaciones no cierran con la tenencia, el costo se lleva a la tenencia al costo promedio de lo
      // conocido: si faltan compras, comparar solo lo conocido contra toda la tenencia inflaría el PnL; si sobran
      // (una venta sin datos o una transferencia fuera de IOL), lo desinflaría.
      const gap = cedear && Math.abs(held - qty) > 0.5 ? round(held - qty, 4) : null
      const known = usd
      if (gap && qty > 0) usd = (usd / qty) * held
      const n = (v: number, d = 1) => v.toLocaleString('es-AR', { maximumFractionDigits: d })
      const notes = [
        `${mine.length} ${mine.length === 1 ? 'operación de IOL convertida' : 'operaciones de IOL convertidas'} al ${cedear ? 'CCL' : 'MEP'} de cada fecha`,
        cedear ? `ratio vigente ${n(ratioNow!)}; cantidades expresadas en CEDEARs actuales` : null,
        skipped ? `${skipped} sin datos suficientes, excluidas` : null,
        unmatched ? `${unmatched} sin correspondencia con la cotización en EE.UU., computadas sin ajuste de ratio` : null,
        gap
          ? `las operaciones suman ${n(qty, 2)} CEDEARs (USD ${n(known, 2)}) frente a ${n(held, 2)} en tenencia; la diferencia se valúa al costo promedio`
          : null,
      ]
      out.set(a.id, { usd, note: `${notes.filter(Boolean).join('; ')}.`, ops: done, gap })
    }
  }
  return { costs: out, retry }
}

async function btcCost(a: Asset): Promise<{ usd: number; note: string } | null> {
  if (!a.address) return null
  type Tx = { txid: string; status: { block_time?: number }; vout: { scriptpubkey_address?: string; value: number }[]; vin: { prevout?: { scriptpubkey_address?: string; value: number } }[] }
  const txs = (await getJson(`https://mempool.space/api/address/${a.address}/txs`)) as Tx[]
  let usd = 0
  let btc = 0
  for (const t of [...txs].sort((x, y) => (x.status.block_time ?? 0) - (y.status.block_time ?? 0))) {
    const received = t.vout.filter((v) => v.scriptpubkey_address === a.address).reduce((s, v) => s + v.value, 0)
    const sent = t.vin.filter((v) => v.prevout?.scriptpubkey_address === a.address).reduce((s, v) => s + (v.prevout?.value ?? 0), 0)
    const net = (received - sent) / 1e8
    if (!t.status.block_time || net === 0) continue
    if (net > 0) {
      const body = (await getJson(`https://mempool.space/api/v1/historical-price?currency=USD&timestamp=${t.status.block_time}`)) as {
        prices?: { USD?: number }[]
      }
      const price = Number(body.prices?.[0]?.USD)
      if (!(price > 0)) return null
      usd += net * price
      btc += net
    } else if (btc > 0) {
      usd -= usd * Math.min(1, -net / btc)
      btc += net
    }
  }
  return usd > 0 ? { usd, note: `${txs.length} transacciones de la address al precio de BTC del día de cada bloque` } : null
}

/** Completa meta.cost_usd de los activos que no lo tienen y tienen una estrategia, y recalcula los de IOL hechos con
 *  una versión anterior de la cuenta. Devuelve un resumen para el log. */
export async function fillMissingCosts(): Promise<string> {
  const assets = await q<Asset>(
    `SELECT s.id, s.key, s.symbol, s.category, s.currency, a.address, s.meta,
            (SELECT SUM(d.delta)::float8 FROM quantity_deltas d WHERE d.asset_id = s.id) AS quantity,
            ls.date::text AS last_date, ls.price::float8 AS last_price
     FROM assets s JOIN accounts a ON a.id = s.account_id
     LEFT JOIN LATERAL (SELECT date, price FROM daily_snapshots ds WHERE ds.asset_id = s.id ORDER BY date DESC LIMIT 1) ls ON true
     WHERE s.active AND (
       (NOT s.meta ? 'cost_usd' AND NOT s.meta ? 'cost_tried')
       OR (s.key LIKE 'iol_ar:%' AND (s.meta->>'cost_source' = 'iol:operaciones' OR NOT s.meta ? 'cost_usd')
           AND COALESCE((s.meta->>'cost_version')::int, 1) < ${COST_VERSION})
     )`,
  )
  const found = new Map<string, Cost & { source: string }>()
  const notes: string[] = []
  let pending: string | null = null

  let iol = assets.filter((a) => a.key.startsWith('iol_ar:') && a.currency === 'ARS' && ['cedears', 'bonos_on', 'acciones'].includes(a.category))
  try {
    const { costs, retry } = await iolCosts(iol)
    for (const [id, r] of costs) found.set(id, { ...r, source: 'iol:operaciones' })
    if (retry.size > 0) {
      const names = iol.filter((a) => retry.has(a.id)).map((a) => a.symbol)
      pending = `sin precio de EE.UU. para ${names.join(', ')} (cargar meta.us_ticker si el ticker difiere), se reintenta en el próximo cierre`
    }
    iol = iol.filter((a) => !retry.has(a.id))
  } catch (error) {
    notes.push(`IOL: ${(error as Error).message}`)
  }
  for (const a of assets.filter((x) => x.symbol === 'BTC' && x.key.startsWith('btc:'))) {
    try {
      const r = await btcCost(a)
      if (r) found.set(a.id, { ...r, ops: [], gap: null, source: 'mempool:historical-price' })
    } catch (error) {
      notes.push(`BTC: ${(error as Error).message}`)
    }
  }

  const tried = [...iol, ...assets.filter((x) => x.symbol === 'BTC' && x.key.startsWith('btc:'))]
  if (tried.length > 0 && notes.length === 0) {
    await q(
      `UPDATE assets s SET meta = s.meta || CASE WHEN x.usd IS NULL THEN jsonb_build_object('cost_tried', true, 'cost_version', ${COST_VERSION})
         ELSE jsonb_build_object('cost_usd', round(x.usd::numeric, 2), 'cost_source', x.source, 'cost_note', x.note,
           'cost_ops', x.ops, 'cost_gap', x.gap, 'cost_version', ${COST_VERSION}) END
       FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, usd float8, source text, note text, ops jsonb, gap float8) WHERE s.id = x.id`,
      [JSON.stringify(tried.map((a) => {
        const r = found.get(a.id)
        return { id: a.id, usd: r?.usd ?? null, source: r?.source ?? null, note: r?.note ?? null, ops: r?.ops ?? null, gap: r?.gap ?? null }
      }))],
    )
    // Un costo recalculado corrige también los cierres anteriores que tenían el costo viejo, para que la serie de PnL
    // no salte el día del recálculo.
    const changed = tried
      .filter((a) => found.has(a.id) && a.meta.cost_usd != null)
      .map((a) => ({ id: a.id, old: Number(a.meta.cost_usd), usd: Math.round(found.get(a.id)!.usd * 100) / 100 }))
      .filter((x) => x.old !== x.usd)
    if (changed.length > 0) {
      await q(
        `UPDATE daily_snapshots ds SET cost_usd = x.usd
         FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, old numeric, usd numeric)
         WHERE ds.asset_id = x.id AND round(ds.cost_usd, 2) = round(x.old, 2)`,
        [JSON.stringify(changed)],
      )
    }
  }
  return [`${found.size} costos nuevos de ${tried.length} pendientes`, ...notes, ...(pending ? [pending] : [])].join('; ')
}
