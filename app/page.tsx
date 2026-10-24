import Link from 'next/link'

import { AssetLogo, CategoryIcon } from '@/components/AssetLogo'
import { CategoryRail } from '@/components/CategoryRail'
import { Chart } from '@/components/Chart'
import { Panel } from '@/components/Panel'
import { Pnl } from '@/components/Pnl'
import { RefreshButton } from '@/components/RefreshButton'
import { shortReason, SyncNotice } from '@/components/SyncNotice'
import { bondSchedule, type BondTerms } from '@/lib/bonds'
import { monthlyFlow } from '@/lib/cashflow'
import { assetLine, CATEGORY_COLORS, flowUsd, label, money, pct, usd } from '@/lib/format'
import { pivot } from '@/lib/pivot'
import { categorySeries, lastSyncRuns, latestFx, latestHoldings, totalSeries, upcomingEvents } from '@/lib/queries'

export const dynamic = 'force-dynamic'
// El botón de refresh corre el cierre como server action de esta página.
export const maxDuration = 800

export default async function Home() {
  const [holdings, total, byCat, events, runs, fx] = await Promise.all([
    latestHoldings(),
    totalSeries(),
    categorySeries(),
    upcomingEvents(),
    lastSyncRuns(),
    latestFx(),
  ])

  if (holdings.length === 0) {
    return (
      <div className="card mt-6 space-y-3 p-8">
        <h1 className="text-2xl font-semibold">Sin información registrada</h1>
        <p className="muted">Registre las cuentas y los activos manuales en Configuración y ejecute el primer cierre.</p>
        <Link href="/onboarding" className="btn inline-block">Ir a Configuración</Link>
      </div>
    )
  }

  // Patrimonio neto = activos a su tasación − deudas. Lo aportado a cada inmueble es dato interno de su ficha.
  const net = holdings.reduce((s, h) => s + h.value_usd, 0)
  const debts = holdings.filter((h) => h.category === 'deuda').reduce((s, h) => s + h.value_usd, 0)
  const assetsTotal = net - debts
  const prev = total.length > 1 ? total[total.length - 2]!.value : null
  const first = total[0]!.value
  const withCost = holdings.filter((h) => h.cost_usd !== null)
  const costValue = withCost.reduce((s, h) => s + h.value_usd, 0)
  const cost = withCost.reduce((s, h) => s + (h.cost_usd ?? 0), 0)

  const cats = new Map<string, { value: number; cost: number | null; n: number }>()
  for (const h of holdings) {
    const c = cats.get(h.category) ?? { value: 0, cost: null, n: 0 }
    c.value += h.value_usd
    c.n += 1
    if (h.cost_usd !== null) c.cost = (c.cost ?? 0) + h.cost_usd
    cats.set(h.category, c)
  }
  const catList = [...cats.entries()].sort((a, b) => b[1].value - a[1].value)
  const stacked = pivot(byCat, ['deuda'])
  const stale = holdings.filter((h) => h.stale).length
  // Flujo de fondos mensual: lo que rinde (valor × APR ÷ 12) y los inmuebles por su flujo (alquiler − expensas), sin tasación.
  const fxNow = fx.cripto?.ars_per_usd ?? null
  const cashflow = holdings
    .filter((h) => (h.category === 'real_estate' ? true : h.value_usd > 0 && (h.apr !== null || Boolean(h.meta.yield_mode))))
    .map((h) => ({ h, property: h.category === 'real_estate', ...monthlyFlow(h, fxNow) }))
    .filter((r) => !r.property || r.income > 0 || r.expense > 0)
  const incomeTotal = cashflow.reduce((s, r) => s + r.income, 0)
  const expenseTotal = cashflow.reduce((s, r) => s + r.expense, 0)
  const flowNet = incomeTotal - expenseTotal
  // Próximo cupón de cada ON, calculado de sus condiciones de emisión, junto con los eventos cargados por API.
  const coupons = holdings.flatMap((h) => {
    const next = h.meta.bond ? bondSchedule(h.meta.bond as BondTerms, holdings[0]!.date)[0] : undefined
    if (!next) return []
    const kind = next.principal > 0 ? 'cupón y amortización' : 'cupón'
    return [{ date: next.date, kind, amount: h.quantity * (next.coupon + next.principal), currency: 'USD', symbol: h.symbol, asset_id: h.asset_id }]
  })
  const upcoming = [...events, ...coupons].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 10)
  // Red de seguridad para wallets: dos posiciones de la misma cuenta con el mismo valor (±1 %, más de USD 100)
  // suelen ser el mismo depósito informado dos veces por Zerion. Se avisa en vez de esconderlo.
  const onchain = holdings.filter((h) => h.price_source === 'zerion' && h.value_usd > 100)
  const dupes = onchain.flatMap((a, i) =>
    onchain.slice(i + 1).filter((b) => b.account === a.account && Math.abs(a.value_usd - b.value_usd) <= 0.01 * a.value_usd).map((b) => `${a.name} y ${b.name}`),
  )
  // Solo cuenta la última corrida de cada fuente: si un reintento salió bien, el error anterior ya no importa.
  const latestBySource = new Map<string, (typeof runs)[number]>()
  for (const r of runs) if (r.date === holdings[0]!.date && !latestBySource.has(r.source)) latestBySource.set(r.source, r)
  const lastErrors = [...latestBySource.values()].filter((r) => r.status === 'error')
  // Errores agrupados por motivo corto, sin los encabezados crudos del proveedor.
  const issueMap = new Map<string, string[]>()
  for (const e of lastErrors) {
    const reason = shortReason(e.detail ?? '')
    issueMap.set(reason, [...(issueMap.get(reason) ?? []), e.source.replace(/^wallet:/, '').replace(/^zerion$/, 'Zerion')])
  }
  const issues = [...issueMap.entries()].map(([reason, sources]) => ({ reason, sources }))

  // Rendimiento promedio: lo que rinden por año los activos con renta (mismo cálculo que el flujo mensual) sobre su valor.
  const yielding = cashflow.filter((r) => !r.property && r.income > 0)
  const yieldBase = yielding.reduce((s, r) => s + r.h.value_usd, 0)
  const yieldRate = yieldBase > 0 ? (yielding.reduce((s, r) => s + r.income, 0) * 12) / yieldBase : null
  const rail = catList.map(([category, c]) => ({ category, value: c.value }))
  // Variación con flecha; lo que redondea a cero va en gris y sin signo, como en Pnl.
  const delta = (v: number, base: number) => {
    if (Math.abs(v) < 0.5) return <span className="muted num font-medium">0 (0,0&nbsp;%)</span>
    return (
      <span className={`num font-medium ${v > 0 ? 'up' : 'down'}`}>
        <span aria-hidden="true">{v > 0 ? '↗ ' : '↘ '}</span>
        {v > 0 ? '+' : ''}
        {usd(v).replace('USD ', '')} ({pct(v / Math.abs(base))})
      </span>
    )
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[220px_minmax(0,1fr)]">
      <CategoryRail cats={rail} net={net} />
      <div className="min-w-0 space-y-6">
        <section className="card overflow-hidden">
          <div className="p-4 sm:p-5">
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div>
                <div className="muted flex items-center gap-2 text-xs"><span>Patrimonio neto al {holdings[0]!.date}</span> <RefreshButton /></div>
                <p className="display num mt-1 text-[40px] leading-none sm:text-5xl">
                  <span className="muted mr-2 align-[0.9em] font-sans text-sm font-medium tracking-widest">USD</span>
                  {usd(net).replace('USD ', '')}
                </p>
                <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  {prev !== null && (
                    <span>
                      {delta(net - prev, prev)} <span className="muted">vs. cierre anterior ·</span>{' '}
                      <Link href="/variacion" className="text-[var(--accent)]">Ver más</Link>
                    </span>
                  )}
                  {total.length >= 2 && <span>{delta(net - first, first)} <span className="muted">desde el {total[0]!.date}</span></span>}
                </p>
              </div>
              <dl className="flex gap-8">
                <div>
                  <dt className="eyebrow">Activos a tasación</dt>
                  <dd className="num mt-1 text-sm font-medium text-[var(--heading)]">{usd(assetsTotal)}</dd>
                </div>
                <div>
                  <dt className="eyebrow">Deudas</dt>
                  <dd className="num mt-1 text-sm font-medium text-[var(--heading)]">{usd(Math.abs(debts))}</dd>
                </div>
              </dl>
            </div>
          </div>
          <div className="grid border-t border-[var(--line)] sm:grid-cols-3">
            <div className="px-4 py-4 sm:px-5">
              <p className="eyebrow">Flujo de fondos mensual</p>
              {cashflow.length > 0 ? (
                <>
                  <p className={`display num mt-1.5 text-2xl ${Math.abs(flowNet) < 0.5 ? '' : flowNet > 0 ? 'text-[var(--up)]' : 'text-[var(--down)]'}`}>{flowNet >= 0.5 ? '+' : ''}{usd(flowNet)}</p>
                  <p className="muted mt-1 text-xs">
                    <span className="num">Ingresos {usd(incomeTotal)} · Egresos {usd(expenseTotal)}</span> ·{' '}
                    <Link href="/flujo" className="text-[var(--accent)]">Historial</Link>
                  </p>
                </>
              ) : (
                <p className="muted mt-1.5 text-sm">Sin activos con renta registrada.</p>
              )}
            </div>
            <div className="border-t border-[var(--line)] px-4 py-4 sm:border-t-0 sm:border-l sm:px-5">
              <p className="eyebrow">Rendimiento promedio</p>
              <p className="display num mt-1.5 text-2xl">{yieldRate !== null ? pct(yieldRate).replace('+', '') : '—'}</p>
              {yieldRate !== null && (
                <p className="muted mt-1 text-xs">Anual, sobre <span className="num">{usd(yieldBase)}</span> que generan renta (sin inmuebles)</p>
              )}
            </div>
            <div className="border-t border-[var(--line)] px-4 py-4 sm:border-t-0 sm:border-l sm:px-5">
              <p className="eyebrow">Resultado sobre costo</p>
              <p className="display mt-1.5 text-2xl"><Link href="/pnl"><Pnl value={costValue} cost={cost || null} stacked /></Link></p>
              <p className="muted mt-1 text-xs">
                Sobre <span className="num">{usd(costValue)}</span> con costo registrado ·{' '}
                <Link href="/pnl" className="text-[var(--accent)]">Detalle de PnL</Link>
              </p>
            </div>
          </div>
          <p className="muted border-t border-[var(--line)] bg-[var(--pale)] px-4 py-2.5 text-[11px] sm:px-5">
            Dólar cripto <span className="num">{fx.cripto ? money(fx.cripto.ars_per_usd, 'ARS') : '—'}</span> · MEP{' '}
            <span className="num">{fx.mep ? money(fx.mep.ars_per_usd, 'ARS') : '—'}</span>
          </p>
        </section>

        {dupes.length > 0 && (
          <p className="card border-l-2 border-l-[var(--down)] px-4 py-3 text-sm">
            <span className="mr-2 rounded-[3px] bg-[var(--warn-soft)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--down)]">Posible duplicación</span>
            {dupes.join('; ')}. Mismo valor en la misma wallet; se recomienda verificarlo antes de tomar el total como definitivo.
          </p>
        )}

        <SyncNotice stale={stale} issues={issues} />

        <Panel title="Evolución del patrimonio neto">
          <Chart data={total} series={[{ key: 'value', label: 'Neto', color: 'var(--accent)' }]} />
        </Panel>

        <div className="grid gap-6 md:grid-cols-5">
          <Panel title="Asignación" aside={`${catList.length} tipos`} className="md:col-span-2">
            <div className="mb-2 flex h-2 gap-0.5 overflow-hidden rounded-[2px]" aria-hidden="true">
              {catList.filter(([, c]) => c.value > 0).map(([cat, c]) => (
                <i key={cat} className="block h-full" style={{ flexGrow: c.value, background: CATEGORY_COLORS[cat] ?? 'var(--faint)' }} />
              ))}
            </div>
            <ul className="text-sm">
              {catList.map(([cat, c]) => (
                <li key={cat} className="border-b border-[var(--line)] last:border-b-0">
                  <Link href={`/c/${cat}`} className="grid grid-cols-[minmax(0,1fr)_auto_3rem] items-baseline gap-2 py-2.5 hover:text-[var(--accent)]">
                    <span className="flex min-w-0 items-center gap-2.5 self-center">
                      <CategoryIcon category={cat} />
                      <span className="truncate">{label(cat)} <span className="muted text-xs">· {c.n}</span></span>
                    </span>
                    <span className={`num ${c.value < 0 ? 'down' : ''}`}>{usd(c.value)}</span>
                    <span className="muted num text-right text-xs">{assetsTotal > 0 && c.value > 0 ? pct(c.value / assetsTotal).replace('+', '') : ''}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title="Evolución por tipo" className="md:col-span-3">
            <Chart
              data={stacked.data}
              stacked
              series={stacked.keys.map((k) => ({ key: k, label: label(k), color: CATEGORY_COLORS[k] ?? 'var(--faint)' }))}
            />
          </Panel>
        </div>

        {cashflow.length > 0 && (
          <Panel
            title="Flujo de fondos mensual"
            aside={<>Neto <span className={`num ${flowNet >= 0 ? 'up' : 'down'}`}>{usd(flowNet)}</span> por mes · <Link href="/flujo" className="text-[var(--accent)]">Historial</Link></>}
          >
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--line)]">
                  <th className="pb-2">Activo</th>
                  <th className="hidden pb-2 text-right sm:table-cell">Valor</th>
                  <th className="hidden pb-2 text-right sm:table-cell">APR</th>
                  <th className="pb-2 pl-3 text-right">Ingresos/mes</th>
                  <th className="pb-2 pl-3 text-right">Egresos/mes</th>
                </tr>
              </thead>
              <tbody>
                {cashflow.map((r) => (
                  <tr key={r.h.asset_id} className="border-b border-[var(--line)]">
                    <td className="py-2.5">
                      <div className="flex items-center gap-3">
                        <AssetLogo symbol={r.h.symbol} category={r.h.category} account={r.h.account} meta={r.h.meta} size={30} />
                        <div className="min-w-0">
                          <Link href={`/a/${r.h.asset_id}`} className="font-medium text-[var(--heading)] hover:text-[var(--accent)]">{r.h.name}</Link>
                          <div className="muted text-xs">{assetLine(r.h)}</div>
                          {!r.property && (
                            <div className="muted text-xs tabular-nums sm:hidden">
                              {usd(r.h.value_usd)} · {r.h.apr !== null ? pct(r.h.apr, 2) : 'APR disponible desde el próximo cierre'}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="num hidden py-2.5 text-right sm:table-cell">{r.property ? '—' : usd(r.h.value_usd)}</td>
                    <td className="num hidden py-2.5 text-right sm:table-cell">
                      {r.property ? '—' : r.h.apr !== null ? pct(r.h.apr, 2) : <span className="muted text-xs">disponible desde el próximo cierre</span>}
                    </td>
                    <td className="num py-2.5 pl-3 text-right">{r.income > 0 ? <span className="up">{flowUsd(r.income)}</span> : '—'}</td>
                    <td className="num py-2.5 pl-3 text-right">{r.expense > 0 ? <span className="down">{flowUsd(r.expense)}</span> : '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-[var(--heading)] font-medium text-[var(--heading)]">
                  <td className="py-2.5">Total mensual</td>
                  <td className="hidden sm:table-cell" />
                  <td className="hidden sm:table-cell" />
                  <td className="num up py-2.5 pl-3 text-right">{usd(incomeTotal)}</td>
                  <td className="num down py-2.5 pl-3 text-right">{usd(expenseTotal)}</td>
                </tr>
              </tfoot>
            </table>
            </div>
            <p className="muted mt-3 text-xs leading-relaxed">
              Metodología: rendimiento mensual = valor × APR ÷ 12 (Nexo y Lemon, APR registrado; préstamos, tasa pactada; Maple, APY publicado por Maple). ON: cupón sobre el valor nominal, de pago semestral; el APR informado es la TIR de mercado vigente.
              Inmuebles: alquileres y expensas registrados en pesos, convertidos al dólar cripto del día; no incluye variaciones de tasación.
              Rendimiento promedio: ingresos mensuales × 12 sobre el valor de los activos con renta, sin inmuebles; en las ON toma el cupón sobre el valor de mercado.
            </p>
          </Panel>
        )}

        <div className="grid gap-6 md:grid-cols-2">
          <Panel title="Principales tenencias" aside={<Link href="/pnl" className="text-[var(--accent)]">Ver PnL</Link>}>
            <table className="w-full text-sm">
              <tbody>
                {holdings.slice(0, 12).map((h) => (
                  <tr key={h.asset_id} className="border-t border-[var(--line)] first:border-t-0">
                    <td className="py-2.5 pr-3">
                      <div className="flex items-center gap-3">
                        <AssetLogo symbol={h.symbol} category={h.category} account={h.account} meta={h.meta} />
                        <div className="min-w-0">
                          <Link href={`/a/${h.asset_id}`} className="font-medium text-[var(--heading)] hover:text-[var(--accent)]">{h.name}</Link>
                          <div className="muted text-xs">{h.account}</div>
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5 text-right">
                      <div className="num">{usd(h.value_usd)}</div>
                      <Pnl value={h.value_usd} cost={h.cost_usd} className="text-xs" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <Panel title="Próximos dividendos y pagos">
            {upcoming.length === 0 ? (
              <p className="muted text-sm">Sin vencimientos registrados. Se incorporan por API (POST /api/v1/events).</p>
            ) : (
              <ul className="text-sm">
                {upcoming.map((e, i) => (
                  <li key={i} className="flex justify-between gap-3 border-t border-[var(--line)] py-2.5 first:border-t-0 first:pt-0">
                    <Link href={`/a/${e.asset_id}`} className="hover:text-[var(--accent)]">
                      <span className="num muted mr-2">{e.date}</span>{e.symbol} · {e.kind}
                    </Link>
                    <span className="num">{e.amount !== null ? money(e.amount, e.currency ?? 'USD') : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  )
}
