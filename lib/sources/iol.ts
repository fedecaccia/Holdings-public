import { getJson, type SourcePosition, type SourceResult } from './types'

// Invertir Online.
// Trampas: de noche responde HTTP 200 con {"message": "..."} en vez de datos;
// `total`/`totalEnPesos` ya incluyen las posiciones (no se suman); monedas en castellano.
// El efectivo es `disponible`, no `saldo`: una compra a 24 hs ya suma el título en /portafolio pero el
// `saldo` no la descuenta hasta que liquida.

const AUTH_URL = process.env.IOL_AUTH_URL || 'https://api.invertironline.com/token'
export const API = (process.env.IOL_API_BASE_URL || 'https://api.invertironline.com').replace(/\/$/, '')

type Activo = {
  cantidad: number
  ultimoPrecio: number
  ppc?: number
  valorizado: number
  titulo: { simbolo: string; descripcion?: string; mercado: string; tipo?: string; moneda: string }
}
type Saldo = { liquidacion?: string; saldo?: number; comprometido?: number; disponible?: number; disponibleOperar?: number }
type Cuenta = { tipo: string; moneda: string; saldo: number; disponible?: number; comprometido?: number; saldos?: Saldo[] }

function currencyOf(moneda: string): 'USD' | 'ARS' {
  if (moneda === 'peso_Argentino') return 'ARS'
  if (moneda === 'dolar_Estadounidense') return 'USD'
  // Una moneda desconocida no se asume dólar: valuar pesos como dólares multiplica por ~1.500.
  throw new Error(`IOL: moneda desconocida "${moneda}"`)
}

function categoryOf(tipo: string | undefined): string {
  const t = (tipo ?? '').toLowerCase()
  if (t.includes('cedear')) return 'cedears'
  if (t.includes('accion')) return 'acciones'
  if (t.includes('obligacion') || t.includes('titulospublicos') || t.includes('bono') || t.includes('letra')) return 'bonos_on'
  if (t.includes('fondo')) return 'fci'
  return 'otros'
}

function assertData(body: unknown, what: string): void {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const keys = Object.keys(body)
    if (keys.length === 1 && keys[0] === 'message') {
      throw new Error(`IOL en mantenimiento (${what}): ${(body as { message: string }).message}`)
    }
  }
}

export async function token(): Promise<string> {
  const username = process.env.IOL_USERNAME
  const password = process.env.IOL_PASSWORD
  if (!username || !password) throw new Error('IOL: faltan IOL_USERNAME / IOL_PASSWORD')
  const response = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password, grant_type: 'password' }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`IOL /token respondió HTTP ${response.status}`)
  const data = (await response.json()) as { access_token?: string }
  if (!data.access_token) throw new Error('IOL /token sin access_token')
  return data.access_token
}

export async function fetchIol(): Promise<SourceResult> {
  const auth = { headers: { authorization: `Bearer ${await token()}` } }
  const [estado, ar, us] = await Promise.all([
    getJson(`${API}/api/v2/estadocuenta`, auth),
    getJson(`${API}/api/v2/portafolio/argentina`, auth),
    getJson(`${API}/api/v2/portafolio/estados_Unidos`, auth), // con mayúscula: en minúsculas da 404
  ])
  assertData(estado, 'estadocuenta')
  assertData(ar, 'portafolio/argentina')
  assertData(us, 'portafolio/estados_Unidos')

  const cuentas = (estado as { cuentas?: Cuenta[] }).cuentas
  if (!Array.isArray(cuentas)) throw new Error('IOL: /estadocuenta cambió de forma')

  const positions: SourcePosition[] = []
  const account = (pais: 'ar' | 'us') => ({
    accountKey: `iol_${pais}`,
    accountName: pais === 'ar' ? 'IOL Argentina' : 'IOL Estados Unidos',
    provider: 'iol',
  })

  const notes: string[] = []
  for (const c of cuentas) {
    const currency = currencyOf(c.moneda)
    const pais = c.tipo.includes('Estados_Unidos') ? 'us' : 'ar'
    const cash = typeof c.disponible === 'number' ? c.disponible : c.saldo
    if (cash !== c.saldo) {
      const plazos = (c.saldos ?? []).map((s) => `${s.liquidacion}: ${s.saldo}/${s.comprometido}/${s.disponible}`).join('; ')
      notes.push(`${pais} ${currency} saldo ${c.saldo}, comprometido ${c.comprometido}, disponible ${c.disponible}${plazos ? ` (${plazos})` : ''}`)
    }
    positions.push({
      ...account(pais),
      key: `iol_${pais}:cash:${currency}`,
      symbol: currency,
      name: `Efectivo ${currency}`,
      category: 'cash',
      currency,
      quantity: String(cash),
      price: '1',
      priceSource: 'iol',
    })
  }

  for (const [pais, body] of [['ar', ar], ['us', us]] as const) {
    const activos = (body as { activos?: Activo[] }).activos
    if (!Array.isArray(activos)) throw new Error(`IOL: /portafolio/${pais} cambió de forma`)
    for (const a of activos) {
      if (!(a.cantidad > 0)) continue
      const currency = currencyOf(a.titulo.moneda)
      // Bonos y ON cotizan cada 100 nominales: el precio unitario sale de valorizado / cantidad.
      const unit = a.valorizado / a.cantidad
      const ratio = a.ultimoPrecio > 0 ? unit / a.ultimoPrecio : 1
      positions.push({
        ...account(pais),
        key: `iol_${pais}:${a.titulo.mercado}:${a.titulo.simbolo}`,
        symbol: a.titulo.simbolo,
        name: a.titulo.descripcion || a.titulo.simbolo,
        category: categoryOf(a.titulo.tipo),
        subtype: a.titulo.tipo ?? null,
        currency,
        quantity: String(a.cantidad),
        price: String(unit),
        priceSource: 'iol',
        avgCost: a.ppc ? String(a.ppc * ratio) : null,
        meta: { market: a.titulo.mercado },
      })
    }
  }

  const note = notes.length > 0 ? `· efectivo = disponible: ${notes.join(' | ')}` : undefined
  return { source: 'iol', accountKeys: ['iol_ar', 'iol_us'], positions, note }
}
