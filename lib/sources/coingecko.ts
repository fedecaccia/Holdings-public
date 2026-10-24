import { getJson } from './types'

/** Precios USD por id de CoinGecko, en una sola llamada. Un precio que falta no vuelve como 0. */
export async function fetchCoingecko(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (ids.length === 0) return out
  const key = process.env.COINGECKO_API_KEY
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.map(encodeURIComponent).join(',')}&vs_currencies=usd`
  const body = (await getJson(url, { headers: key ? { 'x-cg-demo-api-key': key } : {} })) as Record<string, { usd?: number }>
  for (const [id, v] of Object.entries(body)) if (typeof v.usd === 'number' && v.usd > 0) out.set(id, v.usd)
  return out
}
