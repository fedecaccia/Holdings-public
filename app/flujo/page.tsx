import Link from 'next/link'

import { Breadcrumb } from '@/components/Breadcrumb'
import { Panel } from '@/components/Panel'
import { CATEGORY_COLORS, assetLine, flowUsd, label, money, pct, qty, usd } from '@/lib/format'
import { type FlowItem, monthlyFlowDetail } from '@/lib/queries'

export const dynamic = 'force-dynamic'

type Recurring = { amount?: number; currency?: string } | undefined
type Line = { item: FlowItem; amount: number; basis: string }

const daysIn = (m: string) => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).getDate()
const monthName = (m: string) => {
  const s = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1).toLocaleDateString('es-AR', { month: 'long' })
  return `${s.charAt(0).toUpperCase()}${s.slice(1)} ${m.slice(0, 4)}`
}
const dayName = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' })
const sign = (n: number) => (n >= 0 ? 'up' : 'down')
const plain = (t: string) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
const same = (a: string, b: string) => plain(a) === plain(b)

// De dónde sale cada monto, con la misma regla de lib/cashflow.ts: lo devengado por día es lo anual ÷ 365, sumado
// en los días del mes que devengaron. El alquiler y las expensas se leen de la configuración actual del inmueble;
// saldo, nominal y APR son los promedios de esos días, así que con un APR que cambió en el mes la cuenta es aproximada.
function basis(it: FlowItem, kind: 'income' | 'expense'): string {
  const meta = it.meta ?? {}
  const days = it.days === 1 ? '1\u00a0día' : `${it.days}\u00a0días`
  if (it.category === 'real_estate') {
    const r = (kind === 'income' ? meta.recurring_income : meta.recurring_expense) as Recurring
    const what = kind === 'income' ? 'Alquiler' : 'Expensas'
    if (!r?.amount) return `${what} · ${days}`
    const amount = money(Number(r.amount), r.currency ?? 'USD', 0)
    const fx = r.currency === 'ARS' ? ', al dólar cripto de cada día' : ''
    return `${what} de ${amount} por mes × 12 ÷ 365 × ${days}${fx}`
  }
  const rate = (n: number) => pct(n, 2).replace('+', '')
  const bond = meta.bond as { coupon?: number } | undefined
  if (bond?.coupon) return `${qty(it.avg_quantity)} VN × cupón ${rate(bond.coupon)} ÷ 365 × ${days}`
  if (it.min_apr === null || it.max_apr === null) return `Saldo promedio ${usd(it.avg_value)} · ${days}`
  const steady = Math.abs(it.max_apr - it.min_apr) < 0.00005
  return `${steady ? '' : '≈ '}${usd(it.avg_value)} × APR ${rate(it.avg_apr ?? it.min_apr)} ÷ 365 × ${days}`
}

export default async function FlowHistory() {
  const { items, days } = await monthlyFlowDetail()
  const months = [...new Set(days.map((d) => d.date.slice(0, 7)))].map((month) => {
    const list = days.filter((d) => d.date.startsWith(month))
    const mine = items.filter((it) => it.month === month)
    const lines = (kind: 'income' | 'expense'): Line[] =>
      mine
        .filter((it) => it[kind] > 0.005)
        .map((it) => ({ item: it, amount: it[kind], basis: basis(it, kind) }))
        .sort((a, b) => b.amount - a.amount)
    return {
      month,
      days: list,
      income: list.reduce((s, d) => s + d.income, 0),
      expense: list.reduce((s, d) => s + d.expense, 0),
      incomeLines: lines('income'),
      expenseLines: lines('expense'),
    }
  })

  return (
    <div className="space-y-8">
      <Breadcrumb items={[{ href: '/', label: 'Resumen' }, { label: 'Historial de flujo de fondos' }]} />
      <section>
        <h1 className="mb-2 text-3xl">Historial de flujo de fondos</h1>
        <p className="muted mb-6 max-w-2xl text-sm">
          Lo devengado cada día por cada activo, sumado por mes: rendimientos por el APR de ese día, cupones de ON sobre el nominal, y alquiler
          y expensas de los inmuebles al dólar cripto de ese día. No incluye cuotas ni aportes, que son capital.
        </p>
        {months.length === 0 ? (
          <p className="muted text-sm">El registro comienza con el próximo cierre.</p>
        ) : (
          <Panel title="Por mes" aside="Tocá un mes para ver el detalle" className="text-sm">
            <div aria-hidden className="grid grid-cols-[1fr_auto] gap-x-8 border-b border-[var(--line)] pb-2 sm:grid-cols-[1fr_auto_auto_auto]">
              <span className="eyebrow">Mes</span>
              <span className="eyebrow hidden w-28 text-right sm:block">Ingresos</span>
              <span className="eyebrow hidden w-28 text-right sm:block">Egresos</span>
              <span className="eyebrow text-right sm:w-28">Neto</span>
            </div>
            {months.map((m, i) => (
              <details key={m.month} open={i === 0} className="group border-b border-[var(--line)] last:border-b-0">
                {/* En el celular el mes muestra solo el neto; ingresos y egresos pasan a la línea de abajo. */}
                <summary className="grid cursor-pointer list-none grid-cols-[1fr_auto] items-baseline gap-x-8 py-3 hover:bg-[var(--pale)] sm:grid-cols-[1fr_auto_auto_auto] [&::-webkit-details-marker]:hidden">
                  <span className="min-w-0">
                    <span aria-hidden className="mr-1.5 inline-block text-[var(--faint)] transition-transform group-open:rotate-90">›</span>
                    <span className="font-medium text-[var(--heading)]">{monthName(m.month)}</span>
                    {m.days.length < daysIn(m.month) && (
                      <span className="muted hidden text-xs sm:inline"> · {m.days.length} de {daysIn(m.month)} días</span>
                    )}
                    <span className="muted block pl-4 text-xs sm:hidden">
                      <span className="num up">+{usd(m.income)}</span> · <span className="num down">−{usd(m.expense)}</span>
                      {m.days.length < daysIn(m.month) && ` · ${m.days.length}/${daysIn(m.month)}\u00a0días`}
                    </span>
                  </span>
                  <span className="num up hidden w-28 text-right sm:block"><span className="sr-only">Ingresos </span>{usd(m.income)}</span>
                  <span className="num down hidden w-28 text-right sm:block"><span className="sr-only">Egresos </span>{usd(m.expense)}</span>
                  <span className={`num text-right sm:w-28 ${sign(m.income - m.expense)}`}><span className="sr-only">Neto </span>{usd(m.income - m.expense)}</span>
                </summary>
                <div className="space-y-6 pb-6 pt-2 sm:pl-4">
                  <div className="grid gap-6 lg:grid-cols-2 lg:gap-10">
                    <Breakdown title="Ingresos" lines={m.incomeLines} total={m.income} tone="up" />
                    <Breakdown title="Egresos" lines={m.expenseLines} total={m.expense} tone="down" />
                  </div>
                  <details className="group/days">
                    <summary className="cursor-pointer list-none text-xs font-medium text-[var(--accent)] [&::-webkit-details-marker]:hidden">
                      <span className="group-open/days:hidden">Ver día por día ({m.days.length})</span>
                      <span className="hidden group-open/days:inline">Ocultar día por día</span>
                    </summary>
                    <table className="mt-3 w-full text-sm">
                      <thead>
                        <tr>
                          <th className="py-1.5">Día</th>
                          <th className="py-1.5 text-right">Ingresos</th>
                          <th className="py-1.5 text-right">Egresos</th>
                          <th className="py-1.5 text-right">Neto</th>
                        </tr>
                      </thead>
                      <tbody>
                        {m.days.map((d) => (
                          <tr key={d.date} className="border-t border-[var(--line)]">
                            <td className="py-1.5 capitalize">{dayName(d.date)}</td>
                            <td className="num up py-1.5 text-right">{usd(d.income)}</td>
                            <td className="num down py-1.5 text-right">{usd(d.expense)}</td>
                            <td className={`num py-1.5 text-right ${sign(d.income - d.expense)}`}>{usd(d.income - d.expense)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                </div>
              </details>
            ))}
          </Panel>
        )}
      </section>
    </div>
  )
}

/** Un lado del mes (ingresos o egresos), agrupado por tipo de activo, con el peso de cada activo sobre el total. */
function Breakdown({ title, lines, total, tone }: { title: string; lines: Line[]; total: number; tone: 'up' | 'down' }) {
  if (lines.length === 0) return null
  const share = (n: number) => (total > 0 ? (n / total < 0.01 ? '< 1 %' : `${Math.round((n / total) * 100)} %`) : '')
  const groups = [...new Set(lines.map((l) => l.item.category))]
    .map((c) => ({ category: c, lines: lines.filter((l) => l.item.category === c) }))
    .map((g) => ({ ...g, total: g.lines.reduce((s, l) => s + l.amount, 0) }))
    .sort((a, b) => b.total - a.total)
  return (
    <div>
      <p className="eyebrow mb-2">{title}</p>
      <div className="space-y-4">
        {groups.map((g) => (
          <div key={g.category}>
            <div className="flex items-baseline justify-between gap-3 border-b border-[var(--line)] pb-1.5">
              <span className="flex items-center gap-2 font-medium text-[var(--heading)]">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: CATEGORY_COLORS[g.category] }} />
                {label(g.category)}
              </span>
              <span className={`num ${tone}`}>{flowUsd(g.total)}</span>
            </div>
            <ul>
              {g.lines.map((l) => (
                <li key={l.item.asset_id} className="flex items-start justify-between gap-3 border-b border-[var(--line)] py-2 last:border-b-0">
                  <div className="min-w-0">
                    <Link href={`/a/${l.item.asset_id}`} className="hover:text-[var(--accent)]">
                      {l.item.name}
                    </Link>
                    {!same(l.item.account, label(l.item.category)) && <p className="muted text-xs">{assetLine(l.item)}</p>}
                    <p className="muted text-xs tabular-nums">{l.basis}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className={`num ${tone}`}>{flowUsd(l.amount)}</p>
                    <p className="muted num text-xs">{share(l.amount)}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}
