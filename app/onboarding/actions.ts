'use server'

import { revalidatePath } from 'next/cache'

import { q } from '@/lib/db'
import { todayAR } from '@/lib/dates'
import { applyOwnerConfig } from '@/lib/owner-config'
import { addCashFlow, addValuation, cashFlowSchema, addWallet, assetSchema, createAsset, walletSchema } from '@/lib/ops'
import { runDailySync } from '@/lib/sync'

const str = (f: FormData, k: string): string => String(f.get(k) ?? '').trim()
const numOrNull = (v: string): number | null => (v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

export async function reapplyOwnerConfig(): Promise<void> {
  await applyOwnerConfig()
  revalidatePath('/onboarding')
}

export async function addWalletAction(form: FormData): Promise<void> {
  await addWallet(walletSchema.parse({ provider: str(form, 'provider'), address: str(form, 'address'), name: str(form, 'name') }))
  revalidatePath('/onboarding')
}

export async function deactivateAccount(form: FormData): Promise<void> {
  await q(`UPDATE accounts SET active = false WHERE key = $1`, [str(form, 'key')])
  revalidatePath('/onboarding')
}

const slug = (v: string): string => v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export async function saveProperty(form: FormData): Promise<void | string> {
  const category = str(form, 'category')
  const group = category === 'vehiculo' ? 'vehiculos' : 'inmuebles'
  if (!str(form, 'name')) return 'Indique el nombre'
  // Uno nuevo toma su clave y símbolo del nombre.
  const key = str(form, 'key') || `manual:${group}:${slug(str(form, 'name'))}`
  const symbol = str(form, 'symbol') || slug(str(form, 'name')).slice(0, 12).toUpperCase()
  const meta: Record<string, unknown> = {
    invested_base_usd: numOrNull(str(form, 'investedUsd')),
    purchase_value_usd: numOrNull(str(form, 'purchaseUsd')),
    recurring_expense: { amount: numOrNull(str(form, 'expenseAmount')) ?? 0, currency: str(form, 'expenseCurrency') || 'ARS' },
    recurring_income: { amount: numOrNull(str(form, 'incomeAmount')) ?? 0, currency: str(form, 'incomeCurrency') || 'ARS' },
    invested_as_of: todayAR(),
  }
  const asset = await createAsset(
    assetSchema.parse({
      account_key: category === 'vehiculo' ? 'manual:vehiculos' : 'manual:inmuebles',
      account_name: category === 'vehiculo' ? 'Vehículos' : 'Inmuebles',
      key,
      symbol,
      name: str(form, 'name'),
      category,
      currency: 'USD',
      price_source: str(form, 'priceSource'),
      meta,
    }),
  )
  const valuation = numOrNull(str(form, 'valuationUsd'))
  if (valuation !== null) {
    await addValuation({ asset: asset.key, value: String(valuation), currency: 'USD', date: todayAR(), external_id: `form:${asset.key}:${todayAR()}:${valuation}` })
  }
  revalidatePath('/onboarding')
}

/** Plan de cuotas de un inmueble: lo crea (con el inmueble elegido) o cambia sus parámetros. */
export async function saveDebt(form: FormData): Promise<void | string> {
  const meta = {
    total_installments: numOrNull(str(form, 'totalInstallments')),
    reference_installment_ars: numOrNull(str(form, 'referenceInstallmentArs')),
  }
  const key = str(form, 'key')
  if (key) {
    await q(`UPDATE assets SET meta = meta || $2::jsonb WHERE key = $1`, [key, JSON.stringify(meta)])
  } else {
    const [property] = await q<{ id: string; key: string; name: string }>(`SELECT id, key, name FROM assets WHERE key = $1`, [str(form, 'property')])
    if (!property) return 'Primero cargue el inmueble en la sección 2'
    await createAsset(
      assetSchema.parse({
        account_key: 'manual:deudas',
        account_name: 'Deudas',
        key: `manual:deudas:${property.key.split(':').pop()}`,
        symbol: 'DEUDA',
        name: `Cuotas de ${property.name}`,
        category: 'deuda',
        currency: 'ARS',
        price_source: 'debt',
        meta: { ...meta, linked_asset_id: property.id, as_of: todayAR() },
      }),
    )
  }
  revalidatePath('/onboarding')
}

export async function addManualAsset(form: FormData): Promise<void | string> {
  const source = str(form, 'priceSource')
  const aprPct = numOrNull(str(form, 'aprPct'))
  const costUsd = numOrNull(str(form, 'costUsd'))
  if (!str(form, 'symbol')) return 'Indique el símbolo'
  if (source === 'coingecko' && !str(form, 'priceRef')) return 'Indique el id de CoinGecko o seleccione stablecoin'
  const account = str(form, 'account') || 'Manual'
  const key = `manual:${account}:${str(form, 'symbol')}`.toLowerCase().replace(/\s+/g, '-')
  const [exists] = await q<{ name: string }>(`SELECT name FROM assets WHERE key = $1`, [key])
  if (exists) return `Ya existe "${exists.name}". Para modificar la cantidad, registre un movimiento por API.`
  await createAsset(
    assetSchema.parse({
      account_key: `manual:${account.toLowerCase().replace(/\s+/g, '-')}`,
      account_name: account,
      key,
      symbol: str(form, 'symbol').toUpperCase(),
      name: str(form, 'name') || str(form, 'symbol'),
      category: str(form, 'category'),
      currency: 'USD',
      price_source: source,
      price_ref: source === 'coingecko' ? str(form, 'priceRef') : undefined,
      meta: {
        ...(aprPct !== null ? { apr_manual: aprPct / 100 } : {}),
        ...(costUsd !== null ? { cost_usd: costUsd, cost_source: 'manual' } : {}),
      },
      initial_quantity: str(form, 'quantity') || undefined,
    }),
  )
  revalidatePath('/onboarding')
}

/** Valor de compra total en USD de cualquier activo. Se usa desde el próximo cierre para el PnL. */
export async function saveCost(form: FormData): Promise<void | string> {
  const id = str(form, 'id')
  const cost = numOrNull(str(form, 'costUsd'))
  if (cost === null || cost < 0) return 'Indique un monto en USD'
  await q(`UPDATE assets SET meta = meta || jsonb_build_object('cost_usd', $2::numeric, 'cost_source', 'manual') - 'cost_tried' WHERE id = $1`, [id, cost])
  revalidatePath(`/a/${id}`)
}

export async function runSyncAction(): Promise<void> {
  await runDailySync()
  revalidatePath('/')
  revalidatePath('/onboarding')
}

export async function addCuota(form: FormData): Promise<void> {
  const date = str(form, 'date') || todayAR()
  const amount = parseNumber(str(form, 'amount'))
  const fx = parseNumber(str(form, 'fx'))
  const asset = str(form, 'asset')
  await addCashFlow(cashFlowSchema.parse({
    asset, date, kind: 'cuota', amount, currency: 'ARS',
    fx_ars_usd: fx || undefined, note: str(form, 'note') || undefined,
    external_id: `form:${asset}:cuota:${date}:${amount}`,
  }))
  revalidatePath('/onboarding')
}

/** Acepta 1234567.89 y también 1.234.567,89. */
function parseNumber(v: string): string {
  return v.includes(',') ? v.replace(/\./g, '').replace(',', '.') : v
}

export async function deleteCuota(form: FormData): Promise<void> {
  // Solo las cargadas desde la app o la API; las del archivo de configuración volverían al re-aplicarlo.
  await q(`DELETE FROM cash_flows WHERE id = $1 AND kind = 'cuota'`, [str(form, 'id')])
  revalidatePath('/onboarding')
}
