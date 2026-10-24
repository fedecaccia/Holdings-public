// Flujo mensual recurrente de un activo, en USD. Una sola regla para el Resumen, las tablas por tipo y el cierre diario:
// - inmuebles: alquiler (ingreso) y expensas (gasto) cargados en meta, en su moneda; no se mira la tasación.
// - ON: el cupón que cobra sobre el nominal (nominal × cupón ÷ 12); se paga cada semestre, acá se mensualiza.
// - todo lo demás: valor × APR ÷ 12 (Nexo, Lemon, Maple, préstamos). Sin APR no hay flujo.

type Recurring = { amount?: number | string; currency?: string } | null | undefined

export type FlowInput = { category: string; quantity: number; value_usd: number; apr: number | null; meta: Record<string, unknown> }

export function recurringUsd(r: unknown, arsPerUsd: number | null): number {
  const { amount, currency } = (r ?? {}) as NonNullable<Recurring>
  const n = Number(amount ?? 0)
  if (!(n > 0)) return 0
  return currency === 'USD' ? n : arsPerUsd ? n / arsPerUsd : 0
}

export function monthlyFlow(h: FlowInput, arsPerUsd: number | null): { income: number; expense: number } {
  if (h.category === 'real_estate') {
    return { income: recurringUsd(h.meta.recurring_income, arsPerUsd), expense: recurringUsd(h.meta.recurring_expense, arsPerUsd) }
  }
  const bond = h.meta.bond as { coupon?: number } | undefined
  if (bond?.coupon) return { income: h.quantity > 0 ? (h.quantity * bond.coupon) / 12 : 0, expense: 0 }
  return { income: h.value_usd > 0 && h.apr !== null ? (h.value_usd * h.apr) / 12 : 0, expense: 0 }
}

/** Lo devengado en un día: el flujo mensual llevado a diario (× 12 ÷ 365). */
export const dailyFromMonthly = (monthly: number): number => (monthly * 12) / 365
