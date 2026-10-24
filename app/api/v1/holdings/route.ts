import { handler } from '@/lib/api'
import { allAssets, dailyChange, latestFx, latestHoldings, withInstallments } from '@/lib/queries'

export const dynamic = 'force-dynamic'

// ?changes=1 suma la variación de cada activo contra el cierre anterior (la misma tabla de /variacion), para que un agente
// pueda explicar por qué se movió el patrimonio.
export const GET = handler(null, async (_body, request) => {
  const withChanges = new URL(request.url).searchParams.get('changes') === '1'
  const [holdings, assets, fx, changes] = await Promise.all([latestHoldings().then(withInstallments), allAssets(), latestFx(), withChanges ? dailyChange() : null])
  const total = holdings.reduce((s, h) => s + h.value_usd, 0)
  return { date: holdings[0]?.date ?? null, total_usd: total, fx, holdings, assets, ...(changes ? { changes } : {}) }
})
