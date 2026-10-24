export const CATEGORY_LABELS: Record<string, string> = {
  stablecoin: 'Stablecoins',
  crypto: 'Cripto',
  defi: 'DeFi',
  acciones: 'Acciones',
  cedears: 'CEDEARs',
  bonos_on: 'Bonos y ON',
  fci: 'FCI',
  cash: 'Efectivo',
  real_estate: 'Inmuebles',
  vehiculo: 'Vehículos',
  prestamos: 'Préstamos otorgados',
  otros: 'Otros',
  deuda: 'Deudas',
}

// Colores de categoría: variables CSS de globals.css, así cambian solos en modo oscuro.
export const CATEGORY_COLORS: Record<string, string> = Object.fromEntries(
  Object.keys(CATEGORY_LABELS).map((c) => [c, `var(--c-${c})`]),
)

export const label = (category: string): string => CATEGORY_LABELS[category] ?? category

// Espacio duro (\u00a0) entre moneda y número, y antes del %, para que un monto nunca se parta en dos líneas.
// Lo que redondea a cero se muestra como 0, nunca "-0".
export function usd(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const n = Math.abs(value) < 0.5 / 10 ** digits ? 0 : value
  return `USD\u00a0${n.toLocaleString('es-AR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

export function ars(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `ARS$\u00a0${(Math.abs(value) < 0.5 ? 0 : value).toLocaleString('es-AR', { maximumFractionDigits: 0 })}`
}

export function money(value: number | null | undefined, currency: string, digits = 2): string {
  if (currency === 'ARS') return ars(value)
  return usd(value, digits)
}

export function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const raw = value * 100
  const n = Math.abs(raw) < 0.5 / 10 ** digits ? 0 : raw
  return `${n > 0 ? '+' : ''}${n.toLocaleString('es-AR', { maximumFractionDigits: digits, minimumFractionDigits: digits })}\u00a0%`
}

/** Flujo mensual: un rendimiento de centavos (un saldo chico con APR) se muestra "< USD 1", no "USD 0". */
export function flowUsd(value: number): string {
  return value > 0 && value < 1 ? '< USD\u00a01' : usd(value)
}

export function qty(value: number): string {
  const abs = Math.abs(value)
  return value.toLocaleString('es-AR', { maximumFractionDigits: abs >= 100 ? 2 : abs >= 1 ? 4 : 8 })
}

// Tipos internos de IOL e IBKR que repiten la categoría; el subtipo útil es la red de una wallet o el protocolo.
const NOISY_SUBTYPES = /^(ObligacionesNegociables|CEDEARS|ACCIONES|STK|CASH|TitulosPublicos|FondoComundeInversion)$/i

/** Segunda línea de un activo en las tablas: cuenta, categoría (si se pide y no repite la cuenta) y subtipo útil. */
export function assetLine(h: { account: string; subtype: string | null; category: string }, withCategory = false): string {
  const plain = (t: string) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  const parts = [h.account]
  if (withCategory && plain(label(h.category)) !== plain(h.account)) parts.push(label(h.category))
  if (h.subtype && !NOISY_SUBTYPES.test(h.subtype)) parts.push(h.subtype)
  return parts.join(' · ')
}
