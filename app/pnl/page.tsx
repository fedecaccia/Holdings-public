import { Breadcrumb } from '@/components/Breadcrumb'
import { Pnl } from '@/components/Pnl'
import { type PnlRow, PnlTable } from '@/components/PnlTable'
import { assetLine, usd } from '@/lib/format'
import { latestHoldings } from '@/lib/queries'

export const dynamic = 'force-dynamic'

// Detalle del PnL del resumen: cada activo con costo conocido, valor del último cierre menos costo.
// Se calcula al abrir la página, no se guarda.
export default async function PnlBreakdown() {
  const holdings = await latestHoldings()
  const without = holdings.filter((h) => h.cost_usd === null && h.category !== 'deuda')

  const data: PnlRow[] = holdings
    .filter((h) => h.cost_usd !== null)
    .map((h) => ({
      id: h.asset_id,
      name: h.name,
      symbol: h.symbol,
      meta: { protocol: h.meta.protocol, chain: h.meta.chain },
      category: h.category,
      account: h.account,
      detail: assetLine({ ...h, account: '' }).replace(/^ · /, ''),
      cost: h.cost_usd!,
      value: h.value_usd,
    }))

  const cost = data.reduce((s, r) => s + r.cost, 0)
  const value = data.reduce((s, r) => s + r.value, 0)

  return (
    <div className="space-y-8">
      <Breadcrumb items={[{ href: '/', label: 'Resumen' }, { label: 'Detalle de PnL' }]} />
      <section className="overflow-x-auto">
        <h1 className="mb-2 text-3xl">Detalle de PnL</h1>
        <p className="muted max-w-2xl text-sm">
          Resultado por activo al {holdings[0]?.date ?? '—'}: valuación de cierre menos costo de adquisición en USD. Los inmuebles
          financiados en cuotas computan como costo lo aportado más el saldo pendiente.
        </p>
        <p className="figure mt-4">
          <span className="cur">USD</span>
          <span className={value - cost >= 0.5 ? 'up' : value - cost <= -0.5 ? 'down' : ''}>
            {value - cost >= 0.5 ? '+' : ''}
            {usd(value - cost).replace('USD\u00a0', '')}
          </span>
        </p>
        <p className="mt-3 mb-6 text-xs">
          <Pnl value={value} cost={cost || null} pctOnly />{' '}
          <span className="muted num">costo {usd(cost)} → valor {usd(value)}</span>
        </p>
        <PnlTable rows={data} />
        {without.length > 0 && (
          <p className="muted mt-3 text-xs">
            Excluidos por no tener costo de adquisición registrado ({usd(without.reduce((s, h) => s + h.value_usd, 0))}):{' '}
            {without.map((h) => h.name).join(', ')}.
          </p>
        )}
      </section>
    </div>
  )
}
