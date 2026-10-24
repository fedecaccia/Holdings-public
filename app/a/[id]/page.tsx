import { notFound } from 'next/navigation'

import { saveCost } from '@/app/onboarding/actions'
import { ActionForm } from '@/components/ActionForm'
import { AssetLogo } from '@/components/AssetLogo'
import { Breadcrumb } from '@/components/Breadcrumb'
import { Chart } from '@/components/Chart'
import { Pnl } from '@/components/Pnl'
import { CATEGORY_COLORS, label, money, pct, qty, usd } from '@/lib/format'
import { recurringUsd } from '@/lib/cashflow'
import { assetDetail, assetSeries, latestFx } from '@/lib/queries'

export const dynamic = 'force-dynamic'

type Recurring = { amount?: number; currency?: string } | undefined

export default async function AssetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const [{ asset, deltas, flows, events }, series, fx] = await Promise.all([assetDetail(id), assetSeries(id), latestFx()])
  if (!asset) notFound()

  const meta = (asset.meta ?? {}) as Record<string, unknown>
  const last = series[series.length - 1]
  const category = String(asset.category)
  const aprSeries = series.filter((p) => p.apr !== null)
  const expense = meta.recurring_expense as Recurring
  const income = meta.recurring_income as Recurring
  // Lo aportado es dato interno: base inicial + cuotas y aportes cargados. El valor del activo es su tasación.
  const contributed = meta.invested_base_usd != null
    ? Number(meta.invested_base_usd) + flows.filter((f) => f.kind === 'cuota' || f.kind === 'aporte').reduce((s, f) => s + f.amount_usd, 0)
    : null
  // Detalle del costo calculado con las operaciones de IOL (lib/costs.ts). En CEDEARs, el ratio implícito es la
  // cotización en EE.UU. de ese día sobre lo pagado por CEDEAR: muestra el ratio vigente en cada operación.
  const costOps = Array.isArray(meta.cost_ops)
    ? (meta.cost_ops as { d: string; t: string; n: number; ars: number | null; fx: number; usd: number; us?: number; x?: number }[])
    : []
  const pending = contributed !== null && last?.cost != null && last.cost - contributed > 1 ? last.cost - contributed : null

  return (
    <div className="space-y-8">
      <Breadcrumb items={[{ href: '/', label: 'Resumen' }, { href: `/c/${category}`, label: label(category) }, { label: String(asset.name) }]} />
      <section className="grid gap-6 md:grid-cols-3">
        <div className="md:col-span-2">
          <p className="eyebrow">{String(asset.account)} · {String(asset.symbol)}</p>
          <h1 className="mt-2 flex items-center gap-3 text-3xl">
            <AssetLogo symbol={String(asset.symbol)} category={category} account={String(asset.account)} meta={meta} size={40} />
            {String(asset.name)}
          </h1>
          <p className="figure mt-4">
            {last ? <><span className="cur">USD</span>{usd(last.value).replace('USD\u00a0', '')}</> : '—'}
          </p>
          {last?.cost ? <p className="mt-3 text-xs"><Pnl value={last.value} cost={last.cost} /> <span className="muted">sobre costo de adquisición</span></p> : null}
        </div>
        <div className="space-y-1.5 border-[var(--line)] text-sm md:border-l md:pl-6">
          {last && last.quantity !== 1 && <p>Cantidad: <span className="num">{qty(last.quantity)}</span></p>}
          {last?.price != null && <p>Precio: <span className="num">{money(last.price, String(asset.currency))}</span></p>}
          {last?.apr != null && <p>APR: <span className="num">{pct(last.apr, 2)}</span></p>}
          {contributed !== null && <p>Aportado a la fecha: <span className="num">{usd(contributed)}</span></p>}
          {pending !== null && <p>Saldo pendiente: <span className="num">{usd(pending)}</span></p>}
          {meta.purchase_value_usd != null && <p>Costo de adquisición: <span className="num">{usd(Number(meta.purchase_value_usd))}</span></p>}
          {Number(expense?.amount) > 0 && <p>Egreso mensual: <RecurringAmount r={expense!} fx={fx.cripto?.ars_per_usd ?? null} /></p>}
          {Number(income?.amount) > 0 && <p>Ingreso mensual: <RecurringAmount r={income!} fx={fx.cripto?.ars_per_usd ?? null} /></p>}
          {meta.total_installments != null && <p>Cuotas del plan: {String(meta.total_installments)}</p>}
          {typeof meta.cost_note === 'string' && <p className="muted text-xs">Costo de adquisición: {meta.cost_note}</p>}
          {typeof meta.bond_note === 'string' && <p className="muted text-xs">{meta.bond_note}. APR = TIR de mercado al precio de hoy.</p>}
        </div>
        {contributed === null && category !== 'deuda' && (
          <ActionForm action={saveCost} className="flex flex-wrap items-end gap-2 md:col-span-3" label="Guardar costo de adquisición">
            <input type="hidden" name="id" value={id} />
            <label className="muted text-xs">
              Costo de adquisición total (USD)
              <input name="costUsd" defaultValue={meta.cost_usd != null ? String(meta.cost_usd) : ''} className="w-40" />
            </label>
          </ActionForm>
        )}
      </section>

      {costOps.length > 0 && (
        <section className="overflow-x-auto">
          <h2 className="mb-1 text-sm font-medium">Operaciones que componen el costo</h2>
          <p className="muted mb-3 text-xs">
            Operaciones de IOL convertidas a USD con el dólar de cada fecha. En CEDEARs, la cantidad se expresa también en CEDEARs
            actuales según el ratio vigente en cada operación, contrastado con la cotización del subyacente en EE.UU.
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="py-2">Fecha</th>
                <th className="py-2 pl-3 text-right">Cantidad</th>
                <th className="hidden py-2 pl-3 text-right sm:table-cell">Pesos</th>
                <th className="hidden py-2 pl-3 text-right sm:table-cell">Tipo de cambio</th>
                <th className="py-2 pl-3 text-right">USD</th>
                {costOps.some((o) => o.us) && <th className="hidden py-2 pl-3 text-right sm:table-cell">Subyacente</th>}
                {costOps.some((o) => o.us) && <th className="hidden py-2 pl-3 text-right sm:table-cell">Ratio implícito</th>}
              </tr>
            </thead>
            <tbody>
              {costOps.map((o, i) => (
                <tr key={i} className="border-t border-[var(--line)]">
                  <td className="py-2">
                    {o.d}
                    <div className="muted text-xs">{o.t}</div>
                  </td>
                  <td className="num py-2 pl-3 text-right">
                    {qty(o.n)}
                    {o.x && o.x !== 1 && <div className="muted text-xs">= {qty(o.n * o.x)} actuales</div>}
                  </td>
                  <td className="num hidden py-2 pl-3 text-right sm:table-cell">{o.ars ? money(o.ars, 'ARS') : '—'}</td>
                  <td className="num hidden py-2 pl-3 text-right sm:table-cell">{o.fx === 1 ? '—' : money(o.fx, 'ARS')}</td>
                  <td className={`num py-2 pl-3 text-right ${o.t === 'Venta' ? 'down' : ''}`}>{o.t === 'Venta' ? '−' : ''}{usd(o.usd, 2)}</td>
                  {costOps.some((c) => c.us) && (
                    <td className="num hidden py-2 pl-3 text-right sm:table-cell">{o.us ? usd(o.us, 2) : '—'}</td>
                  )}
                  {costOps.some((c) => c.us) && (
                    <td className="num muted hidden py-2 pl-3 text-right sm:table-cell">
                      {o.us ? (o.us / (o.usd / o.n)).toLocaleString('es-AR', { maximumFractionDigits: 1 }) : '—'}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-medium">Evolución</h2>
        <Chart data={series} series={[{ key: 'value', label: 'Valor', color: CATEGORY_COLORS[category] ?? 'var(--accent)' }]} />
      </section>

      {aprSeries.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-medium">APR diario</h2>
          <Chart data={aprSeries} unit="pct" series={[{ key: 'apr', label: 'APR', color: 'var(--c-defi)' }]} height={200} />
        </section>
      )}

      <section className="grid gap-8 md:grid-cols-2">
        <div>
          <h2 className="mb-3 text-sm font-medium">Movimientos</h2>
          {deltas.length === 0 ? <p className="muted text-sm">Sin movimientos registrados.</p> : (
            <ul className="space-y-2 text-sm">
              {deltas.map((d, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span>{d.date} · <span className="muted">{d.source}</span>{d.note ? ` · ${d.note}` : ''}</span>
                  <span className={`num ${d.delta >= 0 ? 'up' : 'down'}`}>{d.delta >= 0 ? '+' : ''}{qty(d.delta)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h2 className="mb-3 text-sm font-medium">Pagos, gastos y dividendos</h2>
          {flows.length === 0 && events.length === 0 ? <p className="muted text-sm">Sin registros.</p> : (
            <ul className="space-y-2 text-sm">
              {events.map((e, i) => (
                <li key={`e${i}`} className="flex justify-between gap-3"><span>{e.date} · {e.kind}{e.note ? ` · ${e.note}` : ''}</span><span className="num">{e.amount !== null ? money(e.amount, e.currency ?? 'USD') : ''}</span></li>
              ))}
              {flows.map((f, i) => (
                <li key={`f${i}`} className="flex justify-between gap-3 border-t border-[var(--line)] pt-1 first:border-t-0 first:pt-0">
                  <span>{f.date} · {f.kind}{f.note ? <span className="muted"> · {f.note}</span> : ''}</span>
                  <span className="text-right">
                    <span className="num block">{money(f.amount, f.currency)}</span>
                    {f.currency !== 'USD' && <span className="muted num block text-xs">{usd(f.amount_usd)}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  )
}

/** Gasto o ingreso fijo en su moneda, con el equivalente en USD al dólar cripto de hoy (lo que usa el flujo de fondos mensual). */
function RecurringAmount({ r, fx }: { r: { amount?: number; currency?: string }; fx: number | null }) {
  const currency = r.currency ?? 'ARS'
  return (
    <span className="num">
      {money(Number(r.amount), currency)}
      {currency !== 'USD' && <span className="muted"> ({usd(recurringUsd(r, fx))})</span>}
    </span>
  )
}
