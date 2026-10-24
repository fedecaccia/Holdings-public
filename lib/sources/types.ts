/** Lo que devuelve cada fuente automática. Las cantidades y precios van como string para no perder decimales. */
export type SourcePosition = {
  accountKey: string
  accountName: string
  provider: string
  address?: string
  key: string
  symbol: string
  name: string
  category: string
  subtype?: string | null
  currency: 'USD' | 'ARS'
  quantity: string
  /** Precio unitario en `currency`. null = lo pone CoinGecko después. */
  price: string | null
  priceSource: string
  priceRef?: string | null
  /** Costo promedio unitario informado por el broker, en `currency`. */
  avgCost?: string | null
  meta?: Record<string, unknown>
}

/** accountKeys: cuentas cuyo activo que no vino pasa a cero. note: se agrega al detalle del cierre. */
export type SourceResult = { source: string; accountKeys: string[]; positions: SourcePosition[]; note?: string }

// HTTP 429 (límite de pedidos): reintenta hasta 4 veces esperando lo que diga Retry-After o el header de reset
// por segundo (Zerion manda límite, restante y reset por segundo, día y mes), o si no 2, 4, 8 y 16 s.
// Si lo agotado es la cuota del día o del mes, reintentar no sirve: corta enseguida.
// El error lleva los headers de límite para saber cuál se pasó.
export async function getJson(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<unknown> {
  let response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' })
  for (let attempt = 1; response.status === 429 && attempt <= 4 && !quotaExhausted(response.headers); attempt++) {
    const reset = Number(response.headers.get('retry-after') ?? headerLike(response.headers, /second.*reset|reset.*second/))
    await sleep(reset > 0 && reset <= 30 ? reset * 1000 : 1000 * 2 ** attempt)
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' })
  }
  if (response.status === 429) {
    const limits = [...response.headers].filter(([k]) => /rate|limit|retry/i.test(k)).map(([k, v]) => `${k}=${v}`).join(' ')
    const kind = quotaExhausted(response.headers) ? 'cuota agotada' : 'demasiados pedidos'
    throw new Error(`${new URL(url).host} respondió HTTP 429 (${kind}) ${limits}`.trim())
  }
  if (!response.ok) throw new Error(`${new URL(url).host} respondió HTTP ${response.status}`)
  return response.json()
}

function headerLike(headers: Headers, pattern: RegExp): string | null {
  for (const [k, v] of headers) if (pattern.test(k)) return v
  return null
}

/**
 * Se agotó una cuota larga (día o mes): un header `*day*remaining*`/`*month*remaining*` en 0, o el genérico
 * `ratelimit-remaining` en 0 con un reset de más de un minuto. Zerion (tier demo) manda
 * `ratelimit-limit: 75;w=86400`, `ratelimit-remaining: 0` y `ratelimit-reset: <segundos hasta medianoche UTC>`.
 */
export function quotaExhausted(headers: Headers): boolean {
  const zero = (v: string | null) => v !== null && v.trim() !== '' && Number(v) <= 0
  if ([...headers].some(([k, v]) => /(day|month).*remaining|remaining.*(day|month)/i.test(k) && zero(v))) return true
  return zero(headers.get('ratelimit-remaining')) && Number(headers.get('ratelimit-reset')) > 60
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const STABLES = new Set(['USDC', 'USDT', 'DAI', 'USDC.E', 'USDBC', 'USDE', 'PYUSD', 'FDUSD', 'TUSD', 'BUSD', 'GHO', 'USDS', 'LUSD', 'FRAX', 'USD0', 'CUSD'])
export function isStable(symbol: string): boolean {
  return STABLES.has(symbol.toUpperCase())
}
