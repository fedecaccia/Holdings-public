import config from '@/db/owner-config.json'

import { q } from './db'
import { todayAR } from './dates'
import { addCashFlow, addEvent, addValuation, addWallet, createAsset, type CATEGORIES } from './ops'

// Configuración del dueño (db/owner-config.json): todo lo que no viene de una API. Se aplica con la base vacía.
// GET /api/v1/owner-config la vuelve a generar desde la base (exportOwnerConfig): sirve de backup para reconstruir
// una base nueva desde el estado de hoy. Con datos reales, no commitearla en un repo público.
// Idempotente y sin pisar nada: volver a aplicarla solo agrega lo que falta. Un activo que ya existe no se toca
// (ni su meta ni sus movimientos), y flujos, tasaciones y eventos no se repiten.

type Category = (typeof CATEGORIES)[number]
type Meta = Record<string, unknown>
type Recurring = { amount: number; currency: string }
type Text = string | null | undefined

export type OwnerConfig = {
  _nota?: string
  wallets: { provider: string; name: string; address: string }[]
  properties: {
    key: string
    name: string
    symbol: string
    category: string
    price_source: string
    currency?: string
    subtype?: string
    invested_base_usd?: number | null
    purchase_value_usd?: number | null
    recurring_expense?: Recurring
    recurring_income?: Recurring
    note?: string
    contributions?: { date: string; amount_usd: string; note?: Text; external_id?: Text }[]
    valuation_usd?: number
    valuation_date?: string
    meta?: Meta
  }[]
  /** Deuda en cuotas atada a un inmueble (por ejemplo, un departamento en pozo). Opcional. */
  installment_debt?: {
    key: string
    name?: string
    linked_property: string
    total_installments: number
    nominal_installment_ars: number
    note?: string
    paid_installments: { n: number; date: string; amount_ars: string; fx_ars_usd?: Text; external_id?: Text }[]
    meta?: Meta
  } | null
  manual_holdings: {
    key: string
    account: string
    account_key?: string
    name: string
    symbol: string
    category: string
    currency?: string
    subtype?: string
    quantity: string
    apr?: number
    price_source?: string
    price_ref?: string
    meta?: Meta
    /** Movimientos que suman `quantity`, con su external_id: un agente que reintenta no los vuelve a cargar. */
    deltas?: { date: string; delta: string; unit_price?: Text; source?: string; note?: Text; external_id?: Text }[]
  }[]
  loans: {
    key: string
    name: string
    debtor: string
    symbol?: string
    principal_usd: number
    rate_annual: number
    start_date: string
    maturity_date: string | null
    note?: string
    meta?: Meta
  }[]
  /** Flujos que no son aportes ni cuotas del inmueble en cuotas (expensas, impuestos, alquiler...). */
  cash_flows?: { asset: string; date: string; kind: string; amount: string; currency: string; fx_ars_usd?: Text; note?: Text; external_id?: Text }[]
  /** Últimas tasaciones que no van como valuation_usd de un inmueble (en ARS, o de otros activos manuales). */
  valuations?: { asset: string; date: string; value: string; currency: string; note?: Text }[]
  /** Fechas de dividendos y cupones de activos manuales. */
  events?: { asset: string; date: string; kind: string; amount?: Text; currency?: Text; note?: Text; external_id?: Text }[]
  _nota_asset_meta?: string
  asset_meta?: { account: string; symbol: string; key?: string; meta: Meta }[]
}

export const ownerConfig = config as unknown as OwnerConfig

export async function isEmpty(): Promise<boolean> {
  const [row] = await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM accounts`)
  return (row?.n ?? 0) === 0
}

export async function applyOwnerConfig(): Promise<{ wallets: number; assets: number; flows: number }> {
  const c = ownerConfig
  const today = todayAR()
  let assets = 0
  let flows = 0

  const [existingRows, looseFlows, valuationRows, eventRows] = await Promise.all([
    q<{ key: string }>(`SELECT key FROM assets`),
    // Flujos cargados sin external_id (por la API): se reconocen por activo + fecha + tipo + monto, uno por uno.
    q<{ key: string; date: string; kind: string; amount: number }>(
      `SELECT s.key, f.date::text AS date, f.kind, f.amount::float8 AS amount
       FROM cash_flows f JOIN assets s ON s.id = f.asset_id WHERE f.external_id IS NULL`,
    ),
    q<{ key: string; date: string }>(`SELECT s.key, v.date::text AS date FROM manual_valuations v JOIN assets s ON s.id = v.asset_id`),
    q<{ key: string; date: string; kind: string }>(`SELECT s.key, e.date::text AS date, e.kind FROM asset_events e JOIN assets s ON s.id = e.asset_id`),
  ])
  const known = new Set(existingRows.map((r) => r.key))
  const loose = new Map<string, number>()
  for (const f of looseFlows) {
    const id = `${f.key}|${f.date}|${f.kind}|${f.amount.toFixed(2)}`
    loose.set(id, (loose.get(id) ?? 0) + 1)
  }
  const valued = new Set(valuationRows.map((v) => `${v.key}|${v.date}`))
  const evented = new Set(eventRows.map((e) => `${e.key}|${e.date}|${e.kind}`))

  // Solo crea: un activo que ya existe queda como está (lo cambiado desde la app o la API gana).
  const create = async (input: Parameters<typeof createAsset>[0] & { key: string }) => {
    if (known.has(input.key)) return null
    const r = await createAsset(input)
    known.add(input.key)
    assets++
    return r
  }
  const flow = async (f: { asset: string; date: string; kind: string; amount: string; currency: string; fx_ars_usd?: Text; note?: Text; external_id: string }) => {
    if (!known.has(f.asset)) return
    const id = `${f.asset}|${f.date}|${f.kind}|${Number(f.amount).toFixed(2)}`
    const n = loose.get(id) ?? 0
    if (n > 0) {
      loose.set(id, n - 1)
      return
    }
    const r = await addCashFlow({
      asset: f.asset, date: f.date, kind: f.kind as 'cuota', amount: f.amount, currency: f.currency as 'USD',
      fx_ars_usd: f.fx_ars_usd ?? undefined, note: f.note ?? undefined, external_id: f.external_id,
    })
    if (r.created) flows++
  }
  const valuation = async (v: { asset: string; date: string; value: string; currency: string; note?: Text }) => {
    if (!known.has(v.asset) || valued.has(`${v.asset}|${v.date}`)) return
    valued.add(`${v.asset}|${v.date}`)
    await addValuation({
      asset: v.asset, value: v.value, currency: v.currency as 'USD', date: v.date, note: v.note ?? undefined,
      external_id: `config:${v.asset}:valuation:${v.date}`,
    })
  }

  for (const w of c.wallets) await addWallet({ provider: w.provider as 'zerion', address: w.address, name: w.name })

  for (const p of c.properties) {
    const group = p.key.split(':')[1] ?? 'otros'
    await create({
      account_key: `manual:${group}`,
      account_name: group[0]!.toUpperCase() + group.slice(1),
      key: p.key,
      symbol: p.symbol,
      name: p.name,
      category: p.category as Category,
      subtype: p.subtype,
      currency: (p.currency ?? 'USD') as 'USD',
      price_source: p.price_source as 'manual',
      meta: {
        ...p.meta,
        invested_base_usd: p.invested_base_usd,
        ...(p.purchase_value_usd != null ? { purchase_value_usd: p.purchase_value_usd } : {}),
        ...(p.recurring_expense ? { recurring_expense: p.recurring_expense } : {}),
        ...(p.recurring_income ? { recurring_income: p.recurring_income } : {}),
        ...(p.note ? { note: p.note } : {}),
      },
    })
    for (const [i, k] of (p.contributions ?? []).entries()) {
      await flow({
        asset: p.key, date: k.date, kind: 'aporte', amount: k.amount_usd, currency: 'USD', note: k.note,
        external_id: k.external_id ?? `config:${p.key}:aporte:${i + 1}`,
      })
    }
    if (p.valuation_usd && p.valuation_date) {
      await valuation({ asset: p.key, date: p.valuation_date, value: String(p.valuation_usd), currency: 'USD' })
    }
  }

  const d = c.installment_debt
  if (d) {
    const [linkedProperty] = await q<{ id: string }>(`SELECT id FROM assets WHERE key = $1`, [d.linked_property])
    await create({
      account_key: 'manual:deudas',
      account_name: 'Deudas',
      key: d.key,
      symbol: 'DEUDA',
      name: d.name ?? 'Deuda en cuotas',
      category: 'deuda',
      currency: 'ARS',
      price_source: 'debt',
      meta: {
        ...d.meta,
        // El sync resta las cuotas cargadas como flujo: total − pagas = las que faltan.
        total_installments: d.total_installments,
        reference_installment_ars: d.nominal_installment_ars,
        linked_asset_id: linkedProperty?.id ?? null,
        note: d.note,
      },
    })
    for (const k of d.paid_installments) {
      await flow({
        asset: d.linked_property, date: k.date, kind: 'cuota', amount: k.amount_ars, currency: 'ARS',
        fx_ars_usd: k.fx_ars_usd, note: `cuota ${k.n}/${d.total_installments}`,
        external_id: k.external_id ?? `config:${d.key}:cuota:${k.n}`,
      })
    }
  }

  for (const h of c.manual_holdings) {
    const asset = await create({
      account_key: h.account_key ?? `manual:${h.account.toLowerCase()}`,
      account_name: h.account,
      key: h.key,
      symbol: h.symbol,
      name: h.name,
      category: h.category as Category,
      subtype: h.subtype,
      currency: (h.currency ?? 'USD') as 'USD',
      price_source: (h.price_source ?? 'stable') as 'stable',
      price_ref: h.price_ref,
      meta: { ...h.meta, ...(h.apr != null ? { apr_manual: h.apr } : {}) },
      initial_quantity: h.deltas?.length || Number(h.quantity) === 0 ? undefined : h.quantity,
      date: today,
    })
    // Activo nuevo: su historia de movimientos, en un solo INSERT.
    if (asset && h.deltas?.length) {
      await q(
        `INSERT INTO quantity_deltas (asset_id, date, delta, unit_price, source, external_id, note)
         SELECT $1, x.date, x.delta, x.unit_price, COALESCE(x.source, 'onboarding'), x.external_id, x.note
         FROM jsonb_to_recordset($2::jsonb) AS x(date date, delta numeric, unit_price numeric, source text, external_id text, note text)
         ON CONFLICT (external_id) DO NOTHING`,
        [asset.id, JSON.stringify(h.deltas)],
      )
    }
  }

  for (const l of c.loans) {
    await create({
      account_key: 'manual:prestamos',
      account_name: 'Préstamos otorgados',
      key: l.key,
      symbol: l.symbol ?? l.debtor.toUpperCase().replace(/\s+/g, '-'),
      name: l.name,
      category: 'prestamos',
      currency: 'USD',
      price_source: 'loan',
      meta: {
        ...l.meta,
        principal_usd: l.principal_usd, rate_annual: l.rate_annual, start_date: l.start_date,
        maturity_date: l.maturity_date, note: l.note,
      },
    })
  }

  for (const [i, f] of (c.cash_flows ?? []).entries()) {
    await flow({ ...f, external_id: f.external_id ?? `config:${f.asset}:${f.kind}:${f.date}:${i + 1}` })
  }
  for (const v of c.valuations ?? []) await valuation(v)
  for (const e of c.events ?? []) {
    if (!known.has(e.asset) || evented.has(`${e.asset}|${e.date}|${e.kind}`)) continue
    await addEvent({
      asset: e.asset, date: e.date, kind: e.kind as 'otro', amount: e.amount ?? undefined, currency: (e.currency ?? undefined) as 'USD',
      note: e.note ?? undefined, external_id: e.external_id ?? `config:${e.asset}:${e.kind}:${e.date}`,
    })
  }

  return { wallets: c.wallets.length, assets, flows }
}

/**
 * Datos de activos que traen las fuentes (IOL, IBKR, wallets) y que la fuente no da: condiciones de las ON,
 * valor de compra en USD. Se mezclan cada cierre por cuenta + símbolo (o por `key` exacta cuando la cuenta tiene
 * dos activos con el mismo símbolo), solo las claves que el activo no tiene, así lo cargado después desde la app
 * gana. Un solo UPDATE en lote.
 */
export async function applyAssetMeta(): Promise<void> {
  const rows = ownerConfig.asset_meta ?? []
  if (rows.length === 0) return
  await q(
    `UPDATE assets s SET meta = x.meta || s.meta
     FROM jsonb_to_recordset($1::jsonb) AS x(account text, symbol text, key text, meta jsonb), accounts c
     WHERE c.id = s.account_id AND c.key = x.account AND s.symbol = x.symbol AND (x.key IS NULL OR s.key = x.key)
       AND NOT (s.meta ?& ARRAY(SELECT jsonb_object_keys(x.meta)))`,
    [JSON.stringify(rows)],
  )
}

// ── Export: la configuración con el estado de hoy ──────────────────────────────────────────────────────────

// Claves de meta que se cargan a mano en activos de fuentes automáticas (lo demás lo trae la fuente o se recalcula).
const SOURCE_META_KEYS = ['bond', 'bond_note', 'cost_usd', 'cost_source', 'cost_note', 'cost_version', 'cost_gap', 'cost_ops', 'us_ticker', 'apr_manual', 'note']
// Claves internas que no tienen sentido en otra base (ids, marcas de correcciones, fechas de formularios).
const isInternal = (k: string) => k === 'linked_asset_id' || k === 'as_of' || k === 'invested_as_of' || k.startsWith('fix_')

/** `"1234.500000000000000000"` → `"1234.5"`. */
const dec = (v: string | number | null): string => {
  const s = String(v ?? '0')
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}
const numOrUndef = (v: unknown): number | undefined => (v === null || v === undefined || v === '' ? undefined : Number(v))

/** Meta sin las claves que ya van como campo propio ni las internas; undefined si queda vacía. */
function restMeta(meta: Meta, used: string[]): Meta | undefined {
  const out = Object.fromEntries(Object.entries(meta).filter(([k]) => !used.includes(k) && !isInternal(k)))
  return Object.keys(out).length ? out : undefined
}

type AssetRow = { id: string; key: string; symbol: string; name: string; category: string; price_source: string; price_ref: string | null; currency: string; subtype: string | null; meta: Meta; account_key: string; account_name: string; provider: string }
type FlowRow = { key: string; date: string; kind: string; amount: string; currency: string; fx_ars_usd: string | null; external_id: string | null; note: string | null }

/** Genera db/owner-config.json desde la base: 6 consultas de lectura, sin escribir nada. */
export async function exportOwnerConfig(): Promise<OwnerConfig> {
  const [wallets, assets, deltas, flows, valuations, events] = await Promise.all([
    q<{ provider: string; name: string; address: string }>(
      `SELECT provider, name, address FROM accounts WHERE provider IN ('zerion', 'btc', 'near', 'mvx') AND active ORDER BY created_at, key`,
    ),
    q<AssetRow>(
      `SELECT s.id, s.key, s.symbol, s.name, s.category, s.price_source, s.price_ref, s.currency, s.subtype, s.meta,
              a.key AS account_key, a.name AS account_name, a.provider
       FROM assets s JOIN accounts a ON a.id = s.account_id WHERE s.active AND a.active ORDER BY s.created_at, s.key`,
    ),
    q<{ key: string; date: string; delta: string; unit_price: string | null; source: string; external_id: string | null; note: string | null }>(
      `SELECT s.key, d.date::text AS date, d.delta::text AS delta, d.unit_price::text AS unit_price, d.source, d.external_id, d.note
       FROM quantity_deltas d JOIN assets s ON s.id = d.asset_id JOIN accounts a ON a.id = s.account_id
       WHERE a.provider = 'manual' ORDER BY d.date, d.created_at, d.external_id`,
    ),
    q<FlowRow>(
      `SELECT s.key, f.date::text AS date, f.kind, f.amount::text AS amount, f.currency, f.fx_ars_usd::text AS fx_ars_usd,
              f.external_id, f.note
       FROM cash_flows f JOIN assets s ON s.id = f.asset_id ORDER BY f.date, f.created_at, f.external_id`,
    ),
    q<{ key: string; date: string; value: string; currency: string }>(
      `SELECT DISTINCT ON (v.asset_id) s.key, v.date::text AS date, v.value::text AS value, v.currency
       FROM manual_valuations v JOIN assets s ON s.id = v.asset_id ORDER BY v.asset_id, v.date DESC, v.created_at DESC`,
    ),
    q<{ key: string; date: string; kind: string; amount: string | null; currency: string | null; note: string | null; external_id: string | null }>(
      `SELECT s.key, e.date::text AS date, e.kind, e.amount::text AS amount, e.currency, e.note, e.external_id
       FROM asset_events e JOIN assets s ON s.id = e.asset_id ORDER BY e.date, e.kind, s.key, e.created_at`,
    ),
  ])

  const manual = assets.filter((a) => a.provider === 'manual')
  const byId = new Map(assets.map((a) => [a.id, a]))
  const valuationOf = new Map(valuations.map((v) => [v.key, v]))
  const prev = ownerConfig.installment_debt ?? null
  const debtRow = manual.find((a) => (prev ? a.key === prev.key : a.price_source === 'debt' && a.meta.total_installments != null))
  const debtMeta = debtRow?.meta ?? {}
  const linked = (typeof debtMeta.linked_asset_id === 'string' && byId.get(debtMeta.linked_asset_id)?.key) || prev?.linked_property || ''
  const used = new Set<FlowRow>()

  const properties: OwnerConfig['properties'] = manual
    .filter((a) => a.price_source === 'manual' || a.price_source === 'invested')
    .map((a) => {
      const m = a.meta
      const contributions = flows.filter((f) => f.key === a.key && f.kind === 'aporte' && f.currency === 'USD')
      contributions.forEach((f) => used.add(f))
      // Tasación en USD acá; una en ARS va a `valuations`.
      const v = valuationOf.get(a.key)
      return {
        key: a.key,
        name: a.name,
        symbol: a.symbol,
        category: a.category,
        price_source: a.price_source,
        currency: a.currency === 'USD' ? undefined : a.currency,
        subtype: a.subtype ?? undefined,
        invested_base_usd: numOrUndef(m.invested_base_usd) ?? null,
        purchase_value_usd: numOrUndef(m.purchase_value_usd),
        recurring_expense: m.recurring_expense as Recurring | undefined,
        recurring_income: m.recurring_income as Recurring | undefined,
        note: typeof m.note === 'string' ? m.note : undefined,
        contributions: contributions.length
          ? contributions.map((f) => ({ date: f.date, amount_usd: dec(f.amount), note: f.note, external_id: f.external_id }))
          : undefined,
        ...(v && v.currency === 'USD' ? { valuation_usd: Number(v.value), valuation_date: v.date } : {}),
        meta: restMeta(m, ['invested_base_usd', 'purchase_value_usd', 'recurring_expense', 'recurring_income', 'note']),
      }
    })

  // Cuotas en orden de pago; el número sale de la nota ("cuota 7/36") o de la posición.
  const cuotas = flows
    .filter((f) => f.key === linked && f.kind === 'cuota')
    .map((f) => ({ f, n: Number(/cuota (\d+)\//.exec(f.note ?? '')?.[1] ?? NaN) }))
    .sort((x, y) => x.f.date.localeCompare(y.f.date) || (x.n || 0) - (y.n || 0))
  cuotas.forEach(({ f }) => used.add(f))
  const installment_debt: OwnerConfig['installment_debt'] = debtRow
    ? {
        key: debtRow.key,
        name: debtRow.name,
        linked_property: linked,
        total_installments: numOrUndef(debtMeta.total_installments) ?? prev?.total_installments ?? 0,
        nominal_installment_ars: numOrUndef(debtMeta.reference_installment_ars) ?? prev?.nominal_installment_ars ?? 0,
        note: typeof debtMeta.note === 'string' ? debtMeta.note : prev?.note,
        paid_installments: cuotas.map(({ f, n }, i) => ({
          n: Number.isFinite(n) ? n : i + 1, date: f.date, amount_ars: dec(f.amount), fx_ars_usd: f.fx_ars_usd && dec(f.fx_ars_usd), external_id: f.external_id,
        })),
        meta: restMeta(debtMeta, ['total_installments', 'reference_installment_ars', 'note']),
      }
    : prev

  const manual_holdings: OwnerConfig['manual_holdings'] = manual
    .filter((a) => a.price_source !== 'manual' && a.price_source !== 'invested' && a.price_source !== 'debt' && a.price_source !== 'loan')
    .map((a) => {
      const ds = deltas.filter((d) => d.key === a.key)
      const total = ds.reduce((s, d) => s + Number(d.delta), 0)
      return {
        key: a.key,
        account: a.account_name,
        account_key: a.account_key,
        name: a.name,
        symbol: a.symbol,
        category: a.category,
        currency: a.currency === 'USD' ? undefined : a.currency,
        subtype: a.subtype ?? undefined,
        quantity: dec(total.toFixed(10)),
        apr: numOrUndef(a.meta.apr_manual),
        price_source: a.price_source,
        price_ref: a.price_ref ?? undefined,
        meta: restMeta(a.meta, ['apr_manual']),
        deltas: ds.map((d) => ({
          date: d.date, delta: dec(d.delta), unit_price: d.unit_price && dec(d.unit_price), source: d.source, note: d.note, external_id: d.external_id,
        })),
      }
    })

  const loans: OwnerConfig['loans'] = manual
    .filter((a) => a.price_source === 'loan')
    .map((a) => {
      const m = a.meta
      return {
        key: a.key,
        name: a.name,
        debtor: a.name.replace(/^Préstamo a /, ''),
        symbol: a.symbol,
        principal_usd: Number(m.principal_usd),
        rate_annual: Number(m.rate_annual ?? 0),
        start_date: String(m.start_date),
        maturity_date: typeof m.maturity_date === 'string' ? m.maturity_date : null,
        note: typeof m.note === 'string' ? m.note : undefined,
        meta: restMeta(m, ['principal_usd', 'rate_annual', 'start_date', 'maturity_date', 'note']),
      }
    })

  // Solo datos de activos que la configuración vuelve a crear (otra deuda, por ejemplo, no está).
  const exported = new Set([...properties, ...manual_holdings, ...loans].map((a) => a.key).concat(debtRow ? [debtRow.key] : []))
  const cash_flows = flows
    .filter((f) => !used.has(f) && exported.has(f.key))
    .map((f) => ({
      asset: f.key, date: f.date, kind: f.kind, amount: dec(f.amount), currency: f.currency,
      fx_ars_usd: f.fx_ars_usd && dec(f.fx_ars_usd), note: f.note, external_id: f.external_id,
    }))

  const inProperty = new Set(properties.filter((p) => p.valuation_usd !== undefined).map((p) => p.key))
  const otherValuations = valuations
    .filter((v) => exported.has(v.key) && !inProperty.has(v.key))
    .map((v) => ({ asset: v.key, date: v.date, value: dec(v.value), currency: v.currency }))
    .sort((x, y) => x.asset.localeCompare(y.asset))
  const assetEvents = events
    .filter((e) => exported.has(e.key))
    .map((e) => ({ asset: e.key, date: e.date, kind: e.kind, amount: e.amount && dec(e.amount), currency: e.currency, note: e.note, external_id: e.external_id }))

  // Activos de fuentes automáticas con datos cargados a mano. `key` solo si la cuenta repite el símbolo.
  const auto = assets.filter((a) => a.provider !== 'manual')
  const asset_meta = auto
    .map((a) => {
      const meta = Object.fromEntries(SOURCE_META_KEYS.filter((k) => a.meta[k] !== undefined).map((k) => [k, a.meta[k]]))
      const twin = auto.some((b) => b !== a && b.account_key === a.account_key && b.symbol === a.symbol)
      return { account: a.account_key, symbol: a.symbol, ...(twin ? { key: a.key } : {}), meta }
    })
    .filter((r) => Object.keys(r.meta).length > 0)

  return {
    _nota:
      'Configuración del dueño: todo lo que no viene de una API. La genera GET /api/v1/owner-config desde la base (backup: no commitear datos reales en un repo público). Se aplica sola con la base vacía (al abrir /onboarding o en el primer cierre) y es idempotente: correrla de nuevo no duplica nada.',
    wallets,
    properties,
    installment_debt,
    manual_holdings,
    loans,
    cash_flows,
    valuations: otherValuations,
    events: assetEvents,
    _nota_asset_meta: ownerConfig._nota_asset_meta,
    asset_meta,
  }
}
