// ON en dólares: cronograma de pagos y TIR con las condiciones de emisión guardadas en meta.bond (cupón anual
// sobre el nominal, pagos por año, vencimiento bullet y, si el primer período no es regular, la fecha del próximo
// cupón). La TIR de mercado es lo que rinde la ON comprándola hoy; la de cada uno depende del precio de compra y
// se ve en el PnL. El ingreso en efectivo sale del cupón sobre el nominal, no de la TIR.

export type BondTerms = { coupon: number; per_year: number; maturity: string; next_coupon?: string }

export type Payment = { date: string; coupon: number; principal: number } // por 1 de nominal

const day = (s: string) => new Date(`${s}T00:00:00Z`)
const iso = (d: Date) => d.toISOString().slice(0, 10)
const addMonths = (d: Date, n: number) => {
  const x = new Date(d)
  x.setUTCMonth(x.getUTCMonth() + n)
  return x
}

/** Pagos futuros (después de `from`). Con next_coupon se cuenta hacia adelante y el último período puede ser corto. */
export function bondSchedule(terms: BondTerms, from: string): Payment[] {
  const step = 12 / terms.per_year
  const maturity = day(terms.maturity)
  const start = day(from)
  const dates: Date[] = []
  if (terms.next_coupon) {
    for (let d = day(terms.next_coupon); d < maturity; d = addMonths(d, step)) dates.push(d)
  } else {
    for (let i = 1; i < 400; i++) {
      const d = addMonths(maturity, -i * step)
      if (d <= start) break
      dates.unshift(d)
    }
  }
  dates.push(maturity)
  const out: Payment[] = []
  for (const [i, d] of dates.entries()) {
    if (d <= start) continue
    // Período corto al final (por ejemplo, 14/1 → 14/4 del año de vencimiento) paga la parte proporcional del cupón.
    const prev = i > 0 ? dates[i - 1]! : addMonths(d, -step)
    const months = (d.getUTCFullYear() - prev.getUTCFullYear()) * 12 + d.getUTCMonth() - prev.getUTCMonth()
    out.push({ date: iso(d), coupon: (terms.coupon * months) / 12, principal: i === dates.length - 1 ? 1 : 0 })
  }
  return out
}

/**
 * Rendimiento anual nominal (capitalización según per_year) para un precio sucio por 100 de nominal. En BYMA el
 * precio incluye intereses corridos, así que se compara contra todos los flujos futuros.
 */
export function bondYield(pricePer100: number, terms: BondTerms, date: string): number | null {
  const pays = bondSchedule(terms, date)
  if (!(pricePer100 > 0) || pays.length === 0) return null
  const from = day(date).getTime()
  const flows = pays.map((p) => ({ t: (day(p.date).getTime() - from) / (365 * 86_400_000), cf: 100 * (p.coupon + p.principal) }))
  const pv = (y: number) => flows.reduce((s, f) => s + f.cf / Math.pow(1 + y / terms.per_year, terms.per_year * f.t), 0)
  let lo = -0.5
  let hi = 2
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2
    if (pv(mid) > pricePer100) lo = mid
    else hi = mid
  }
  const y = (lo + hi) / 2
  return Number.isFinite(y) && y > -0.5 && y < 2 ? y : null
}
