import Link from 'next/link'

import { AssetLogo, CategoryIcon } from '@/components/AssetLogo'
import { Breadcrumb } from '@/components/Breadcrumb'
import { CategoryRail } from '@/components/CategoryRail'
import { Chart } from '@/components/Chart'
import { Pnl } from '@/components/Pnl'
import { assetLine, CATEGORY_COLORS, flowUsd, label, money, pct, qty, usd } from '@/lib/format'
import { monthlyFlow } from '@/lib/cashflow'
import { categorySeries, latestFx, latestHoldings } from '@/lib/queries'

export const dynamic = 'force-dynamic'

export default async function CategoryPage({ params }: { params: Promise<{ category: string }> }) {
  const { category } = await params
  const [all, series, fx] = await Promise.all([latestHoldings(), categorySeries(category), latestFx()])
  const holdings = all.filter((h) => h.category === category)
  const total = holdings.reduce((s, h) => s + h.value_usd, 0)
  const withCost = holdings.filter((h) => h.cost_usd !== null)
  const share = (v: number) => (total !== 0 ? Math.max(0, Math.min(100, (v / total) * 100)) : 0)
  const color = CATEGORY_COLORS[category] ?? 'var(--accent)'
  // Inmueble en cuotas = tiene una deuda que lo apunta (meta.linked_asset_id). Sirve para cualquier propiedad.
  const debtOf = (id: string) => all.find((d) => d.category === 'deuda' && d.meta.linked_asset_id === id)
  const showApr = holdings.some((h) => h.apr !== null)
  // Misma regla que el flujo de fondos mensual del Resumen (lib/cashflow.ts).
  const flow = new Map(holdings.map((h) => [h.asset_id, monthlyFlow(h, fx.cripto?.ars_per_usd ?? null)]))
  const property = category === 'real_estate'
  // En inmuebles el flujo completo (alquiler, gastos y neto) se ve siempre, aunque hoy no haya alquiler cargado.
  const showIn = property || [...flow.values()].some((f) => f.income > 0)
  const showOut = property || [...flow.values()].some((f) => f.expense > 0)
  const netOf = (id: string) => flow.get(id)!.income - flow.get(id)!.expense
  // APR de la categoría = flujo neto anual ÷ valor de la categoría. Lo que no rinde cuenta como 0 %, así que en
  // stablecoins es el promedio ponderado por valor y en ON, los cupones del año sobre el valor de mercado.
  const netMonthly = holdings.reduce((s, h) => s + netOf(h.asset_id), 0)
  const categoryApr = total > 0 ? (netMonthly * 12) / total : null
  const signed = (v: number) => (v < 0 ? `−${usd(-v)}` : usd(v))
  const tone = (v: number) => (v < 0 ? 'down' : v > 0 ? 'up' : '')

  // Totales por categoría para el lateral, con el mismo orden que el Resumen.
  const totals = new Map<string, number>()
  for (const h of all) totals.set(h.category, (totals.get(h.category) ?? 0) + h.value_usd)
  const rail = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([c, value]) => ({ category: c, value }))
  const net = all.reduce((s, h) => s + h.value_usd, 0)

  return (
    <div className="grid gap-8 lg:grid-cols-[220px_minmax(0,1fr)]">
      <CategoryRail cats={rail} net={net} current={category} />
      <div className="min-w-0 space-y-8">
      <Breadcrumb items={[{ href: '/', label: 'Resumen' }, { label: label(category) }]} />
      <section>
        <p className="eyebrow flex items-center gap-2">
          <CategoryIcon category={category} size={14} />
          {label(category)} · {holdings.length} {holdings.length === 1 ? 'posición' : 'posiciones'}
        </p>
        <p className="figure mt-2">
          <span className="cur">USD</span>
          {usd(total).replace('USD\u00a0', '')}
        </p>
        {withCost.some((h) => h.cost_usd) && (
          <p className="mt-3 text-xs">
            <Pnl value={withCost.reduce((s, h) => s + h.value_usd, 0)} cost={withCost.reduce((s, h) => s + (h.cost_usd ?? 0), 0) || null} />{' '}
            <span className="muted">sobre costo de adquisición</span>
          </p>
        )}
        {(showIn || showOut) && (
          <p className="mt-1 text-xs">
            <span className="muted">Neto mensual</span> <span className={`num ${tone(netMonthly)}`}>{signed(netMonthly)}</span>
            {categoryApr !== null && (
              <>
                {' · '}<span className="muted">{property ? 'APR' : category === 'bonos_on' ? 'APR estimado por cupón' : 'APR estimado'}</span>{' '}
                <span className={`num ${tone(categoryApr)}`}>{pct(categoryApr, 2)}</span>
              </>
            )}
          </p>
        )}
      </section>
      <section>
        <h2 className="mb-3 text-sm font-medium">Evolución de {label(category)}</h2>
        <Chart data={series} series={[{ key: 'value', label: label(category), color }]} />
      </section>
      <section className="overflow-x-auto">
        <table className="w-full text-sm sm:min-w-[640px]">
          <thead>
            <tr>
              <th className="py-2">Activo</th>
              <th className="hidden py-2 pl-3 text-right sm:table-cell">Cantidad</th>
              <th className="hidden py-2 pl-3 text-right sm:table-cell">Precio</th>
              <th className="py-2 pl-3 text-right">Valor</th>
              <th className="hidden py-2 pl-3 text-right sm:table-cell">Resultado</th>
              {showApr && <th className="hidden py-2 pl-3 text-right sm:table-cell">APR</th>}
              {showIn && <th className="hidden py-2 pl-3 text-right sm:table-cell">{property ? 'Alquiler/mes' : 'Ingresos/mes'}</th>}
              {showOut && <th className="hidden py-2 pl-3 text-right sm:table-cell">{property ? 'Gastos/mes' : 'Egresos/mes'}</th>}
              {property && <th className="hidden py-2 pl-3 text-right sm:table-cell">Neto/mes</th>}
            </tr>
          </thead>
          <tbody>
            {holdings.map((h) => (
              <tr key={h.asset_id} className="border-t border-[var(--line)]">
                <td className="py-2">
                  <div className="flex gap-3">
                    <AssetLogo symbol={h.symbol} category={h.category} account={h.account} meta={h.meta} size={30} />
                    <div className="min-w-0 flex-1">
                      <Link href={`/a/${h.asset_id}`} className="font-medium text-[var(--heading)] hover:text-[var(--accent)]">{h.name}</Link>
                      <div className="muted text-xs">{assetLine(h)}{h.stale ? ' · precio del día anterior' : ''}
                        {category === 'real_estate' && (debtOf(h.asset_id) ? ` · En cuotas, falta ${usd(Math.abs(debtOf(h.asset_id)!.value_usd))}` : ' · Pagado')}
                      </div>
                      {/* En el celular, las columnas secundarias pasan a esta línea. */}
                      <div className="muted mt-0.5 text-xs sm:hidden">
                        {[
                          h.quantity !== 1 && h.price !== null ? `${qty(h.quantity)} × ${money(h.price, h.currency)}` : null,
                          h.apr !== null ? `APR ${pct(h.apr, 2)}` : null,
                          flow.get(h.asset_id)!.income > 0 ? `+${flowUsd(flow.get(h.asset_id)!.income)}/mes` : null,
                          flow.get(h.asset_id)!.expense > 0 ? `−${flowUsd(flow.get(h.asset_id)!.expense)}/mes` : null,
                          property && flow.get(h.asset_id)!.income > 0 ? `neto ${signed(netOf(h.asset_id))}/mes` : null,
                        ].filter(Boolean).join(' · ')}
                      </div>
                      <div className="mt-1.5 h-1 max-w-[260px] rounded-[1px] bg-[var(--line)]">
                        <div className="h-1 rounded-[1px]" style={{ width: `${share(h.value_usd)}%`, background: color }} />
                      </div>
                    </div>
                  </div>
                </td>
                <td className="num hidden py-2 pl-3 text-right sm:table-cell">{qty(h.quantity)}</td>
                <td className="num hidden py-2 pl-3 text-right sm:table-cell">{h.price !== null ? money(h.price, h.currency) : '—'}</td>
                <td className="py-2 pl-3 text-right align-top sm:align-middle">
                  <div className="num">{usd(h.value_usd)}</div>
                  <div className="muted num text-xs">{share(h.value_usd).toFixed(1).replace('.', ',')}{'\u00a0'}%</div>
                  <div className="text-xs sm:hidden"><Pnl value={h.value_usd} cost={h.cost_usd} stacked /></div>
                </td>
                <td className="hidden py-2 pl-3 text-right text-xs sm:table-cell"><Pnl value={h.value_usd} cost={h.cost_usd} /></td>
                {showApr && <td className="num hidden py-2 pl-3 text-right sm:table-cell">{h.apr !== null ? pct(h.apr, 2) : '—'}</td>}
                {showIn && <td className="num hidden py-2 pl-3 text-right sm:table-cell">{flow.get(h.asset_id)!.income > 0 ? <span className="up">{flowUsd(flow.get(h.asset_id)!.income)}</span> : '—'}</td>}
                {showOut && <td className="num hidden py-2 pl-3 text-right sm:table-cell">{flow.get(h.asset_id)!.expense > 0 ? <span className="down">{flowUsd(flow.get(h.asset_id)!.expense)}</span> : '—'}</td>}
                {property && <td className={`num hidden py-2 pl-3 text-right sm:table-cell ${tone(netOf(h.asset_id))}`}>{signed(netOf(h.asset_id))}</td>}
              </tr>
            ))}
          </tbody>
        </table>
        {(showApr || showIn || showOut) && (
          <p className="muted mt-3 text-xs">
            APR: el registrado (Nexo, Lemon), la tasa pactada del préstamo, el APY publicado por Maple, la TIR de mercado de cada ON al
            precio vigente, o el estimado entre cierres para otros depósitos. Ingresos/mes = valor × APR ÷ 12; en ON, el cupón sobre el nominal
            (de pago semestral); en inmuebles, alquileres y expensas registrados.
            {' '}APR de la categoría = flujo neto mensual × 12 ÷ valor de la categoría (lo que no rinde cuenta como 0 %).
          </p>
        )}
      </section>
      </div>
    </div>
  )
}
