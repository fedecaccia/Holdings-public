import { z } from 'zod'

import { q } from './db'
import { isIsoDate, todayAR } from './dates'

// Operaciones de escritura. Las usan la API para agentes y los formularios de la app.

export const CATEGORIES = [
  'stablecoin', 'crypto', 'defi', 'acciones', 'cedears', 'bonos_on', 'fci', 'cash', 'real_estate', 'vehiculo', 'prestamos', 'otros', 'deuda',
] as const

export const PRICE_SOURCES = ['coingecko', 'stable', 'manual', 'invested', 'debt', 'loan', 'iol', 'ibkr', 'zerion'] as const

const decimal = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]).transform(String)
const date = z.string().refine(isIsoDate, 'fecha YYYY-MM-DD').optional()

export class OpError extends Error {}

export async function resolveAsset(ref: string): Promise<{ id: string; currency: string; key: string; category: string }> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(ref)
  const rows = await q<{ id: string; currency: string; key: string; category: string }>(
    `SELECT id, currency, key, category FROM assets WHERE ${isUuid ? 'id = $1::uuid' : 'key = $1'}`,
    [ref],
  )
  if (!rows[0]) throw new OpError(`no existe el activo "${ref}" (usá GET /api/v1/holdings para ver las claves)`)
  return rows[0]
}

async function fxFor(day: string): Promise<number | null> {
  const rows = await q<{ ars_per_usd: string }>(
    `SELECT ars_per_usd FROM fx_rates WHERE type = 'cripto' AND date <= $1 ORDER BY date DESC LIMIT 1`,
    [day],
  )
  if (rows[0]) return Number(rows[0].ars_per_usd)
  const later = await q<{ ars_per_usd: string }>(
    `SELECT ars_per_usd FROM fx_rates WHERE type = 'cripto' ORDER BY date ASC LIMIT 1`,
  )
  return later[0] ? Number(later[0].ars_per_usd) : null
}

// ── Deltas ──────────────────────────────────────────────────────────
export const deltaSchema = z.object({
  asset: z.string().min(1),
  delta: decimal,
  date,
  unit_price: decimal.optional(),
  note: z.string().max(500).optional(),
  external_id: z.string().max(200).optional(),
})

export async function addDeltas(input: z.infer<typeof deltaSchema>[]) {
  const out = []
  for (const d of input) {
    const asset = await resolveAsset(d.asset)
    // Una cantidad negativa no existe (salvo deudas): si un débito la deja bajo cero, falta un movimiento anterior
    // (por ejemplo, un movimiento que nunca se registró). No se carga y se avisa.
    const guard = Number(d.delta) < 0 && asset.category !== 'deuda'
    const rows = await q<{ id: string }>(
      `INSERT INTO quantity_deltas (asset_id, date, delta, unit_price, source, external_id, note)
       SELECT $1::uuid, $2::date, $3::numeric, $4::numeric, 'api', $5::text, $6::text
       WHERE NOT $7::boolean OR (SELECT COALESCE(SUM(delta), 0) FROM quantity_deltas WHERE asset_id = $1::uuid) + $3::numeric >= 0
       ON CONFLICT (external_id) DO NOTHING RETURNING id`,
      [asset.id, d.date ?? todayAR(), d.delta, d.unit_price ?? null, d.external_id ?? null, d.note ?? null, guard],
    )
    if (rows.length === 0 && guard) {
      const seen = d.external_id ? await q(`SELECT 1 FROM quantity_deltas WHERE external_id = $1`, [d.external_id]) : []
      if (seen.length === 0) {
        out.push({ asset: asset.key, delta: d.delta, created: false, duplicate: false, rejected: 'dejaría la cantidad en negativo: falta un movimiento anterior' })
        continue
      }
    }
    out.push({ asset: asset.key, delta: d.delta, created: rows.length > 0, duplicate: rows.length === 0 })
  }
  return out
}

// ── Activos ─────────────────────────────────────────────────────────
export const assetSchema = z.object({
  account_key: z.string().min(1).default('manual'),
  account_name: z.string().optional(),
  key: z.string().min(1).optional(),
  symbol: z.string().min(1),
  name: z.string().min(1),
  category: z.enum(CATEGORIES),
  subtype: z.string().optional(),
  currency: z.enum(['USD', 'ARS']).default('USD'),
  price_source: z.enum(PRICE_SOURCES),
  price_ref: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).default({}),
  initial_quantity: decimal.optional(),
  date,
})

export async function createAsset(input: z.infer<typeof assetSchema>) {
  const existing = await q<{ key: string }>(`SELECT key FROM accounts WHERE key = $1`, [input.account_key])
  const accountKey = existing[0]?.key ?? (input.account_key.includes(':') ? input.account_key : `manual:${input.account_key}`)
  await q(
    `INSERT INTO accounts (key, name, provider, sync) VALUES ($1, $2, 'manual', 'manual') ON CONFLICT (key) DO NOTHING`,
    [accountKey, input.account_name ?? input.account_key],
  )
  const key = input.key ?? `${accountKey}:${input.symbol}`.toLowerCase().replace(/\s+/g, '-')
  const rows = await q<{ id: string; inserted: boolean }>(
    `INSERT INTO assets (account_id, key, symbol, name, category, subtype, currency, price_source, price_ref, meta)
     SELECT a.id, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb FROM accounts a WHERE a.key = $1
     ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category, subtype = EXCLUDED.subtype,
       currency = EXCLUDED.currency, price_source = EXCLUDED.price_source, price_ref = EXCLUDED.price_ref,
       meta = assets.meta || EXCLUDED.meta, active = true
     RETURNING id, (xmax = 0) AS inserted`,
    [accountKey, key, input.symbol, input.name, input.category, input.subtype ?? null, input.currency,
      input.price_source, input.price_ref ?? null, JSON.stringify(input.meta)],
  )
  const asset = rows[0]
  if (!asset) throw new OpError('no se pudo crear el activo')
  if (input.initial_quantity && asset.inserted) {
    await q(
      `INSERT INTO quantity_deltas (asset_id, date, delta, source, note) VALUES ($1, $2, $3, 'onboarding', 'cantidad inicial')`,
      [asset.id, input.date ?? todayAR(), input.initial_quantity],
    )
  }
  return { id: asset.id, key, created: asset.inserted }
}

export const assetPatchSchema = z.object({
  name: z.string().min(1).optional(),
  category: z.enum(CATEGORIES).optional(),
  price_source: z.enum(PRICE_SOURCES).optional(),
  price_ref: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  active: z.boolean().optional(),
})

export async function patchAsset(ref: string, patch: z.infer<typeof assetPatchSchema>) {
  const asset = await resolveAsset(ref)
  await q(
    `UPDATE assets SET
       name = COALESCE($2, name), category = COALESCE($3, category),
       price_source = COALESCE($4, price_source), price_ref = COALESCE($5, price_ref),
       meta = meta || COALESCE($6::jsonb, '{}'::jsonb), active = COALESCE($7, active)
     WHERE id = $1`,
    [asset.id, patch.name ?? null, patch.category ?? null, patch.price_source ?? null, patch.price_ref ?? null,
      patch.meta ? JSON.stringify(patch.meta) : null, patch.active ?? null],
  )
  return { id: asset.id, key: asset.key }
}

// ── Wallets ─────────────────────────────────────────────────────────
export const walletSchema = z.object({
  provider: z.enum(['zerion', 'btc', 'near', 'mvx']),
  address: z.string().min(3),
  name: z.string().min(1),
})

export async function addWallet(input: z.infer<typeof walletSchema>) {
  const address = input.provider === 'zerion' ? input.address.trim().toLowerCase() : input.address.trim()
  if (input.provider === 'zerion' && !/^0x[0-9a-f]{40}$/.test(address)) throw new OpError('address EVM inválida')
  const key = `${input.provider}:${address}`
  await q(
    `INSERT INTO accounts (key, name, provider, sync, address) VALUES ($1, $2, $3, 'auto', $4)
     ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, active = true`,
    [key, input.name, input.provider, address],
  )
  return { key }
}

// ── Flujos (cuotas, expensas, alquiler) ─────────────────────────────
export const cashFlowSchema = z.object({
  asset: z.string().min(1),
  date,
  kind: z.enum(['cuota', 'expensas', 'alquiler', 'impuesto', 'aporte', 'otro']),
  amount: decimal,
  currency: z.enum(['USD', 'ARS']),
  fx_ars_usd: decimal.optional(),
  note: z.string().max(500).optional(),
  external_id: z.string().max(200).optional(),
})

export async function addCashFlow(input: z.infer<typeof cashFlowSchema>) {
  const asset = await resolveAsset(input.asset)
  const day = input.date ?? todayAR()
  const fx = input.fx_ars_usd ? Number(input.fx_ars_usd) : input.currency === 'ARS' ? await fxFor(day) : null
  if (input.currency === 'ARS' && !fx) throw new OpError('no hay dólar cripto cargado para convertir; pasá fx_ars_usd')
  const usd = input.currency === 'USD' ? Number(input.amount) : Number(input.amount) / fx!
  const rows = await q<{ id: string }>(
    `INSERT INTO cash_flows (asset_id, date, kind, amount, currency, fx_ars_usd, amount_usd, external_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (external_id) DO NOTHING RETURNING id`,
    [asset.id, day, input.kind, input.amount, input.currency, fx, usd, input.external_id ?? null, input.note ?? null],
  )
  return { created: rows.length > 0, amount_usd: Math.round(usd * 100) / 100, fx_ars_usd: fx }
}

// ── Tasaciones manuales ─────────────────────────────────────────────
export const valuationSchema = z.object({
  asset: z.string().min(1),
  date,
  value: decimal,
  currency: z.enum(['USD', 'ARS']),
  note: z.string().max(500).optional(),
  external_id: z.string().max(200).optional(),
})

export async function addValuation(input: z.infer<typeof valuationSchema>) {
  const asset = await resolveAsset(input.asset)
  const rows = await q<{ id: string }>(
    `INSERT INTO manual_valuations (asset_id, date, value, currency, external_id, note)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (external_id) DO NOTHING RETURNING id`,
    [asset.id, input.date ?? todayAR(), input.value, input.currency, input.external_id ?? null, input.note ?? null],
  )
  return { created: rows.length > 0 }
}

// ── Dividendos y pagos de cupón ─────────────────────────────────────
export const eventSchema = z.object({
  asset: z.string().min(1),
  date: z.string().refine(isIsoDate, 'fecha YYYY-MM-DD'),
  kind: z.enum(['dividendo', 'cupon', 'amortizacion', 'otro']),
  amount: decimal.optional(),
  currency: z.enum(['USD', 'ARS']).optional(),
  note: z.string().max(500).optional(),
  external_id: z.string().max(200).optional(),
})

export async function addEvent(input: z.infer<typeof eventSchema>) {
  const asset = await resolveAsset(input.asset)
  const rows = await q<{ id: string }>(
    `INSERT INTO asset_events (asset_id, date, kind, amount, currency, external_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (external_id) DO NOTHING RETURNING id`,
    [asset.id, input.date, input.kind, input.amount ?? null, input.currency ?? null, input.external_id ?? null, input.note ?? null],
  )
  return { created: rows.length > 0 }
}
