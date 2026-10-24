import { getJson } from './types'

/** ARS por USD. "cripto" es el que usa la app (se vende cripto para tener pesos); MEP queda de referencia. */
export async function fetchFx(): Promise<{ cripto: number | null; mep: number | null }> {
  const mid = (x: { compra?: number; venta?: number } | undefined): number | null => {
    if (!x || typeof x.compra !== 'number' || typeof x.venta !== 'number') return null
    const v = (x.compra + x.venta) / 2
    return v > 0 ? v : null
  }
  const [cripto, mep] = await Promise.all([
    getJson('https://dolarapi.com/v1/dolares/cripto').then((x) => mid(x as never)).catch(() => null),
    getJson('https://dolarapi.com/v1/dolares/bolsa').then((x) => mid(x as never)).catch(() => null),
  ])
  if (cripto !== null) return { cripto, mep }

  // Respaldo: CriptoYa.
  try {
    const data = (await getJson('https://criptoya.com/api/dolar')) as {
      cripto?: { usdt?: { ask?: number; bid?: number } }
    }
    const usdt = data.cripto?.usdt
    const v = usdt?.ask && usdt?.bid ? (usdt.ask + usdt.bid) / 2 : null
    return { cripto: v, mep }
  } catch {
    return { cripto: null, mep }
  }
}
