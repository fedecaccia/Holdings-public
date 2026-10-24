import { getJson } from './types'

// APY público de syrupUSDC desde la API GraphQL de Maple (docs.maple.finance, Frontend Integration).
// monthlyApy viene escalado: APY % = valor / 1e28, así que en fracción es valor / 1e30.
const SYRUP_USDC_POOL = '0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b'

export async function fetchMapleApy(): Promise<number | null> {
  const body = (await getJson('https://api.maple.finance/v2/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: `{ poolV2(id: "${SYRUP_USDC_POOL}") { monthlyApy } }` }),
  })) as { data?: { poolV2?: { monthlyApy?: string } } }
  const raw = Number(body.data?.poolV2?.monthlyApy)
  return Number.isFinite(raw) && raw > 0 ? raw / 1e30 : null
}
