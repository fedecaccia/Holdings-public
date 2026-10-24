import { sleep, type SourcePosition, type SourceResult } from './types'

// Interactive Brokers, Flex Web Service. La Activity Flex Query (IBKR_FLEX_QUERY_ID) es el cierre del día hábil
// anterior: lo que se opera hoy no aparece hasta mañana. Por eso, si está IBKR_FLEX_TRADES_QUERY_ID (una Trade
// Confirmation Flex Query con período Today), se le suman las operaciones posteriores a ese cierre.
// Trampas: los errores llegan con HTTP 200 dentro del XML; usar solo filas SUMMARY;
// CashReportCurrency trae una fila BASE_SUMMARY que es el total y duplicaría el efectivo.

const BASE = process.env.IBKR_FLEX_BASE_URL || 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService'
const HEADERS = { 'User-Agent': 'holdings/1.0', accept: 'application/xml, text/xml' }

function text(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))
  return m?.[1]?.trim() ?? null
}

// Los atributos del Flex vienen escapados ("JOHNSON &amp; JOHNSON").
function decodeXml(v: string): string {
  return v
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

function rows(xml: string, tag: string): Record<string, string>[] {
  const out: Record<string, string>[] = []
  for (const m of xml.matchAll(new RegExp(`<${tag}\\s([^>]*?)/?>`, 'g'))) {
    const attrs: Record<string, string> = {}
    for (const a of (m[1] ?? '').matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]!] = decodeXml(a[2]!)
    out.push(attrs)
  }
  return out
}

async function get(url: string): Promise<string> {
  const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30_000), cache: 'no-store' })
  if (!response.ok) throw new Error(`IBKR respondió HTTP ${response.status}`)
  return response.text()
}

async function statement(token: string, queryId: string): Promise<string> {
  const send = await get(`${BASE}/SendRequest?t=${encodeURIComponent(token)}&q=${encodeURIComponent(queryId)}&v=3`)
  if (text(send, 'Status') !== 'Success') {
    throw new Error(`IBKR SendRequest: ${text(send, 'ErrorCode') ?? '?'} ${text(send, 'ErrorMessage') ?? ''}`)
  }
  const ref = text(send, 'ReferenceCode')
  const url = text(send, 'Url') || `${BASE}/GetStatement`
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(attempt === 0 ? 2_000 : 5_000)
    const xml = await get(`${url}?t=${encodeURIComponent(token)}&q=${ref}&v=3`)
    if (xml.includes('<FlexQueryResponse')) return xml
    const code = text(xml, 'ErrorCode')
    // 1019 = en generación, 1018 = demasiados pedidos: se reintenta.
    if (code !== '1019' && code !== '1018' && code !== '1001') {
      throw new Error(`IBKR GetStatement: ${code ?? '?'} ${text(xml, 'ErrorMessage') ?? ''}`)
    }
  }
  throw new Error('IBKR: el statement no estuvo listo a tiempo')
}

// Las fechas del Flex pueden venir como 20261023 o 2026-10-23 según la configuración de la query.
// Otro formato (dd/MM/yyyy, MM/dd/yyyy) compararía mal y omitiría operaciones sin aviso: se corta con error.
function ymd(v: string | undefined): string {
  const d = (v ?? '').replace(/\D/g, '').slice(0, 8)
  if (!/^20\d{6}$/.test(d)) throw new Error(`IBKR: fecha "${v}" no es año-mes-día; configurar la Flex Query con yyyyMMdd`)
  return d
}

type Trade = { conid: string; symbol: string; name: string; category: string; quantity: number; price: number; cash: number }

/** Operaciones de la Trade Confirmation Flex Query posteriores a `after` (yyyymmdd), en un solo nivel de detalle. */
function tradesAfter(xml: string, after: string): Trade[] {
  const all = rows(xml, 'TradeConfirm').filter((t) => t.conid && ymd(t.tradeDate) > after)
  // La query puede traer el mismo trade por ejecución, por orden y resumido por símbolo: se usa un solo nivel.
  const level = ['EXECUTION', 'ORDER'].find((l) => all.some((t) => t.levelOfDetail === l))
  const picked = level ? all.filter((t) => t.levelOfDetail === level) : all
  return picked.map((t) => {
    if (t.currency !== 'USD') throw new Error(`IBKR: operación de ${t.symbol} en ${t.currency}, no soportado`)
    const quantity = Number(t.quantity)
    const price = Number(t.price ?? t.tradePrice)
    // netCash ya descuenta comisiones; si no viene, proceeds + commission (la comisión viene negativa).
    const cash = t.netCash !== undefined ? Number(t.netCash) : Number(t.proceeds ?? -quantity * price) + Number(t.commission ?? 0)
    if (![quantity, price, cash].every(Number.isFinite)) throw new Error(`IBKR: operación de ${t.symbol} ilegible`)
    return {
      conid: t.conid!,
      symbol: t.symbol ?? t.conid!,
      name: t.description || t.symbol || t.conid!,
      category: t.assetCategory === 'BOND' ? 'bonos_on' : 'acciones',
      quantity,
      price,
      cash,
    }
  })
}

export async function fetchIbkr(): Promise<SourceResult> {
  const token = process.env.IBKR_FLEX_TOKEN
  const queryId = process.env.IBKR_FLEX_QUERY_ID
  if (!token || !queryId) throw new Error('IBKR: faltan IBKR_FLEX_TOKEN / IBKR_FLEX_QUERY_ID')
  const xml = await statement(token, queryId)

  const account = { accountKey: 'ibkr', accountName: 'Interactive Brokers', provider: 'ibkr' }
  const positions: SourcePosition[] = []

  for (const p of rows(xml, 'OpenPosition')) {
    if (p.levelOfDetail && p.levelOfDetail !== 'SUMMARY') continue
    const qty = Number(p.position)
    if (!p.conid || !Number.isFinite(qty) || qty === 0) continue
    if (p.currency !== 'USD') throw new Error(`IBKR: posición ${p.symbol} en ${p.currency}, no soportado`)
    positions.push({
      ...account,
      key: `ibkr:${p.conid}`,
      symbol: p.symbol ?? p.conid,
      name: p.description || p.symbol || p.conid,
      category: (p.assetCategory ?? 'STK') === 'BOND' ? 'bonos_on' : 'acciones',
      subtype: p.assetCategory ?? null,
      currency: 'USD',
      quantity: p.position!,
      price: p.markPrice ?? null,
      priceSource: 'ibkr',
      priceRef: p.conid,
      avgCost: p.costBasisPrice ?? (p.costBasisMoney ? String(Number(p.costBasisMoney) / qty) : null),
      meta: { reportDate: p.reportDate, isin: p.isin },
    })
  }

  for (const c of rows(xml, 'CashReportCurrency')) {
    if (c.currency === 'BASE_SUMMARY' || c.levelOfDetail === 'BaseCurrency') continue
    if (c.currency !== 'USD') continue
    positions.push({
      ...account,
      key: 'ibkr:cash:USD',
      symbol: 'USD',
      name: 'Efectivo USD',
      category: 'cash',
      currency: 'USD',
      quantity: c.endingCash ?? '0',
      price: '1',
      priceSource: 'ibkr',
    })
  }

  const tradesQueryId = process.env.IBKR_FLEX_TRADES_QUERY_ID
  if (!tradesQueryId) return { source: 'ibkr', accountKeys: ['ibkr'], positions }

  // Fecha del cierre que trae la Activity: lo operado después se suma encima.
  const closed = ymd(xml.match(/<FlexStatement\s[^>]*toDate="([^"]*)"/)?.[1] ?? (positions.find((p) => p.meta?.reportDate)?.meta?.reportDate as string | undefined))
  const trades = tradesAfter(await statement(token, tradesQueryId), closed)
  if (trades.length === 0) return { source: 'ibkr', accountKeys: ['ibkr'], positions }

  const byKey = new Map(positions.map((p) => [p.key, p]))
  let cash = byKey.get('ibkr:cash:USD')
  if (!cash) {
    cash = { ...account, key: 'ibkr:cash:USD', symbol: 'USD', name: 'Efectivo USD', category: 'cash', currency: 'USD', quantity: '0', price: '1', priceSource: 'ibkr' }
    byKey.set(cash.key, cash)
  }
  for (const t of trades) {
    const key = `ibkr:${t.conid}`
    const p = byKey.get(key)
    if (p) {
      const before = Number(p.quantity)
      const after = before + t.quantity
      // Una compra mueve el costo promedio; una venta no.
      if (t.quantity > 0 && p.avgCost && after > 0) p.avgCost = String((Number(p.avgCost) * before + t.price * t.quantity) / after)
      p.quantity = String(after)
    } else {
      // Instrumento nuevo: hasta el próximo cierre de IBKR vale lo que se pagó.
      byKey.set(key, {
        ...account,
        key,
        symbol: t.symbol,
        name: t.name,
        category: t.category,
        subtype: t.category === 'acciones' ? 'STK' : 'BOND',
        currency: 'USD',
        quantity: String(t.quantity),
        price: String(t.price),
        priceSource: 'ibkr',
        priceRef: t.conid,
        avgCost: String(t.price),
        meta: { reportDate: closed, from_trades: true },
      })
    }
    cash.quantity = String(Number(cash.quantity) + t.cash)
  }
  const merged = [...byKey.values()].filter((p) => Math.abs(Number(p.quantity)) > 1e-9)
  return { source: 'ibkr', accountKeys: ['ibkr'], positions: merged, note: `(+${trades.length} operaciones de hoy)` }
}
