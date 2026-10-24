import { getJson, isStable, sleep, type SourcePosition } from './types'

export type Wallet = { accountKey: string; name: string; provider: string; address: string }

// ── EVM (MetaMask, Ledger) + DeFi (Aave, etc.) vía Zerion ─────────────
// Siempre con filter[trash]=only_non_trash: sin él aparecen airdrops falsos con valores enormes.
type ZerionPosition = {
  id: string
  attributes: {
    quantity?: { numeric?: string }
    price?: number | null
    value?: number | null
    position_type?: string
    protocol?: string | null
    name?: string
    fungible_info?: { symbol?: string; name?: string }
    flags?: { is_trash?: boolean }
  }
  relationships?: { chain?: { data?: { id?: string } } }
}

// Tokens que rinden aunque estén "sueltos" en la wallet. price: el token se revaloriza (APR por precio);
// quantity: la cantidad crece sola (APR por cantidad). Solo subyacentes estables o que rebasan en cantidad.
const YIELD_TOKENS: { match: RegExp; protocol: string; mode: 'price' | 'quantity' }[] = [
  { match: /^syrup/i, protocol: 'Maple', mode: 'price' },
  { match: /^sUSDe$/i, protocol: 'Ethena', mode: 'price' },
  { match: /^(sDAI|sUSDS)$/i, protocol: 'Sky', mode: 'price' },
  { match: /^a(Eth|Arb|Bas|Opt|Pol|Ava|Bnb|Sca|Lin|Zks)?(USDC|USDT|DAI|GHO|USDe|WETH|WBTC|cbBTC|wstETH)(\.e|n)?$/, protocol: 'Aave', mode: 'quantity' },
  { match: /^stETH$/i, protocol: 'Lido', mode: 'quantity' },
]

// Trampa: Zerion muestra el depósito en Maple a veces como posición del protocolo (USDC · Maple · deposit) y otras
// solo como el token syrupUSDC en la wallet, y Alchemy solo ve el token. Para que sea siempre un mismo activo
// (con su costo y su historia), el token se lleva a la posición: su clave y la cantidad en USDC (syrupUSDC × precio).
const AS_DEPOSIT: Record<string, { id: string; symbol: string; protocol: string }> = {
  '0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b-ethereum-asset-asset': {
    id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48-ethereum-maple yield: usdc pool-deposit',
    symbol: 'USDC',
    protocol: 'Maple',
  },
}

const STABLE_INSIDE = /(USDC|USDT|DAI|GHO|USDE|USDS|PYUSD|FRAX)/i

export async function fetchZerionWallet(w: Wallet): Promise<SourcePosition[]> {
  const key = process.env.ZERION_API_KEY
  if (!key) throw new Error('Zerion: falta ZERION_API_KEY')
  const url =
    `https://api.zerion.io/v1/wallets/${w.address}/positions/` +
    '?filter[positions]=no_filter&currency=usd&filter[trash]=only_non_trash&sort=value'
  const body = (await getJson(url, {
    headers: { accept: 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
  })) as { data?: ZerionPosition[] }
  if (!Array.isArray(body.data)) throw new Error(`Zerion: respuesta inesperada para ${w.name}`)

  const out: SourcePosition[] = []
  for (const p of body.data) {
    const a = p.attributes
    if (a.flags?.is_trash) continue
    out.push(
      ...evmPosition(w, {
        id: p.id,
        symbol: a.fungible_info?.symbol ?? a.name ?? '?',
        chain: p.relationships?.chain?.data?.id ?? 'evm',
        type: a.position_type ?? 'wallet',
        protocol: a.protocol ?? null,
        quantity: Number(a.quantity?.numeric ?? 0),
        price: Number(a.price ?? 0),
      }),
    )
  }
  // Si vinieron el token y la posición de Maple, los dos quedan con la misma clave: va una sola.
  const seen = new Set<string>()
  return dropDuplicates(out).filter((p) => !seen.has(p.key) && seen.add(p.key))
}

type EvmPositionInput = {
  id: string
  symbol: string
  chain: string
  type: string
  protocol: string | null
  quantity: number
  price: number
}

// Lo comparten Zerion y Alchemy: mismo nombre, categoría y subtipo, y la clave con el id de posición de Zerion,
// así un token leído por Alchemy cae en el mismo activo que si lo hubiera leído Zerion.
function evmPosition(w: Wallet, input: EvmPositionInput): SourcePosition[] {
  const deposit = AS_DEPOSIT[input.id]
  const p = deposit
    ? { ...input, ...deposit, type: 'deposit', quantity: input.quantity * input.price, price: 1 }
    : input
  const { symbol, chain, type, quantity: qty, price } = p
  if (!(qty > 0) || !(price > 0) || Math.abs(qty * price) < 0.5) return []
  const yieldToken = type === 'wallet' ? YIELD_TOKENS.find((t) => t.match.test(symbol)) : undefined
  const isDefi = type !== 'wallet' || yieldToken !== undefined
  const protocol = p.protocol ?? yieldToken?.protocol ?? null
  // Una deuda (loan) resta: cantidad negativa.
  const signed = type === 'loan' ? -qty : qty
  return [
    {
      accountKey: w.accountKey,
      accountName: w.name,
      provider: 'zerion',
      address: w.address,
      key: `zerion:${w.address.toLowerCase()}:${p.id}`,
      symbol,
      name: isDefi ? `${symbol} · ${protocol ?? type} (${chain})` : `${symbol} (${chain})`,
      // Sin sección DeFi: un depósito va a la categoría de lo que hay adentro (syrupUSDC, aUSDC → stablecoins;
      // stETH → cripto). El protocolo y el APR quedan como dato del activo.
      category: isStable(symbol) || (isDefi && STABLE_INSIDE.test(symbol)) ? 'stablecoin' : 'crypto',
      subtype: isDefi ? `${protocol ?? ''} · ${chain}${type === 'wallet' ? '' : ` · ${type}`}`.replace(/^ · /, '') : chain,
      currency: 'USD',
      quantity: String(signed),
      price: String(price),
      // Zerion o Alchemy: el precio viene con la posición. El sync lo trata igual (price_source 'zerion').
      priceSource: 'zerion',
      meta: { chain, position_type: type, protocol, yield_mode: yieldToken?.mode ?? (type === 'wallet' ? null : 'quantity') },
    },
  ]
}

// ── Respaldo de Zerion: Alchemy Portfolio API (ALCHEMY_API_KEY, plan gratis sin tarjeta) ─────────────
// Solo tokens (ERC20 y nativo) con precio, sin posiciones de protocolo. Un pedido por cadena; una cadena que
// falla no tira abajo las demás (lo que no vino queda stale, el sync no pone nada en cero con este respaldo).
// Alchemy no filtra spam como filter[trash] de Zerion, así que en una wallet que ya tiene activos solo se
// actualizan las claves que ya existen con cantidad (known); todo lo demás se ignora. Solo una wallet sin
// activos (recién agregada) toma lo que venga, menos los contratos de SKIP.
// Cadenas de Zerion → red de Alchemy y símbolo de la moneda nativa (Alchemy no lo manda; es el que usa Zerion).
const ALCHEMY_NETWORKS: Record<string, [network: string, native: string]> = {
  ethereum: ['eth-mainnet', 'ETH'],
  base: ['base-mainnet', 'ETH'],
  arbitrum: ['arb-mainnet', 'ETH'],
  optimism: ['opt-mainnet', 'ETH'],
  polygon: ['matic-mainnet', 'POL'],
  'binance-smart-chain': ['bnb-mainnet', 'BNB'],
  avalanche: ['avax-mainnet', 'AVAX'],
  celo: ['celo-mainnet', 'celo'],
  linea: ['linea-mainnet', 'ETH'],
  xdai: ['gnosis-mainnet', 'XDAI'],
}

// Contratos que no se toman nunca: un airdrop falso conocido en BSC
// que Zerion tapa con filter[trash] y el ERC20 de CELO, que es la misma
// moneda nativa de Celo y la contaría dos veces.
const SKIP = new Set(['0xb0557906c617f0048a700758606f64b33d0c41a6', '0x471ece3750da237f93b8e339c536989b8978a438'])

type AlchemyToken = {
  tokenAddress?: string | null
  tokenBalance?: string | null
  tokenMetadata?: { symbol?: string | null; decimals?: number | null }
  tokenPrices?: { currency?: string; value?: string }[]
}

/** known: clave → símbolo de los activos de la cuenta con cantidad. Vacío = wallet nueva. */
export async function fetchAlchemyWallet(w: Wallet, known: Map<string, string>): Promise<{ positions: SourcePosition[]; failed: string[] }> {
  const key = process.env.ALCHEMY_API_KEY
  if (!key) throw new Error('Alchemy: falta ALCHEMY_API_KEY')
  const results = await Promise.allSettled(
    Object.entries(ALCHEMY_NETWORKS).map(async ([chain, [network, native]]) => {
      const tokens: AlchemyToken[] = []
      let pageKey: string | undefined
      do {
        const body = (await getJson(`https://api.g.alchemy.com/data/v1/${key}/assets/tokens/by-address`, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({
            addresses: [{ address: w.address, networks: [network] }],
            withMetadata: true,
            withPrices: true,
            includeNativeTokens: true,
            ...(pageKey ? { pageKey } : {}),
          }),
        })) as { data?: { tokens?: AlchemyToken[]; pageKey?: string | null } }
        if (!Array.isArray(body.data?.tokens)) throw new Error(`respuesta inesperada en ${chain}`)
        tokens.push(...body.data.tokens)
        pageKey = body.data.pageKey ?? undefined
      } while (pageKey)
      return tokens.flatMap((t) => {
        const contract = t.tokenAddress?.toLowerCase() ?? null
        if (contract && SKIP.has(contract)) return []
        const decimals = t.tokenMetadata?.decimals ?? (contract ? null : 18)
        if (decimals === null || !t.tokenBalance) return []
        const id = `${contract ?? 'base'}-${chain}-asset-asset`
        // Un activo que ya existe conserva el símbolo de Zerion (Alchemy dice USDCE donde Zerion dice USDC.e).
        const knownSymbol = known.get(`zerion:${w.address.toLowerCase()}:${id}`)
        const symbol = knownSymbol ?? (contract ? (t.tokenMetadata?.symbol ?? '?') : native)
        // Alchemy no cotiza algunas stablecoins puenteadas (USDC.e en Polygon): valen 1, pero solo si Zerion ya las
        // conocía. Hay decenas de tokens falsos llamados USDC sin precio; uno nuevo sin precio no se toma.
        const price =
          t.tokenPrices?.find((x) => x.currency?.toLowerCase() === 'usd')?.value ?? (knownSymbol && isStable(knownSymbol) ? '1' : undefined)
        return evmPosition(w, {
          id,
          symbol,
          chain,
          type: 'wallet',
          protocol: null,
          quantity: Number(BigInt(t.tokenBalance)) / 10 ** decimals,
          price: Number(price ?? 0),
        })
      })
    }),
  )
  const failed = Object.keys(ALCHEMY_NETWORKS).filter((_, i) => results[i]!.status === 'rejected')
  if (failed.length === results.length) throw new Error(`Alchemy: ${((results[0] as PromiseRejectedResult).reason as Error).message}`)
  const positions = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
  return { positions: known.size === 0 ? positions : positions.filter((p) => known.has(p.key)), failed }
}

// Trampa: con filter[positions]=no_filter, Zerion a veces devuelve el mismo depósito dos veces: como token
// en la wallet (p. ej. aUSDC) y como posición del protocolo (Aave · deposit). Se reconocen por cadena y valor
// (±1 %), y el token tiene que ser de YIELD_TOKENS o contener el símbolo de la posición. Si es de YIELD_TOKENS
// se queda el token (sabemos cómo medir su APR); si no, la posición. Lo que se descarta queda en cero en el sync.
function dropDuplicates(positions: SourcePosition[]): SourcePosition[] {
  const value = (p: SourcePosition) => Math.abs(Number(p.quantity) * Number(p.price))
  const meta = (p: SourcePosition) => (p.meta ?? {}) as { chain?: string; position_type?: string }
  const isYield = (p: SourcePosition) => YIELD_TOKENS.some((y) => y.match.test(p.symbol))
  const drop = new Set<SourcePosition>()
  for (const pos of positions) {
    if (meta(pos).position_type === 'wallet' || meta(pos).position_type === 'loan') continue
    const twin = positions.find(
      (t) =>
        !drop.has(t) &&
        meta(t).position_type === 'wallet' &&
        meta(t).chain === meta(pos).chain &&
        (isYield(t) || t.symbol.toLowerCase().includes(pos.symbol.toLowerCase())) &&
        Math.abs(value(t) - value(pos)) <= 0.01 * Math.max(value(t), value(pos)),
    )
    if (!twin) continue
    drop.add(isYield(twin) ? pos : twin)
  }
  return positions.filter((p) => !drop.has(p))
}

// ── Bitcoin vía mempool.space ─────────────────────────────────────────
export async function fetchBtcWallet(w: Wallet): Promise<SourcePosition[]> {
  const body = (await getJson(`https://mempool.space/api/address/${w.address}`)) as {
    chain_stats?: { funded_txo_sum: number; spent_txo_sum: number }
  }
  if (!body.chain_stats) throw new Error(`mempool.space: respuesta inesperada para ${w.name}`)
  const sats = body.chain_stats.funded_txo_sum - body.chain_stats.spent_txo_sum
  return [btcLike(w, 'BTC', 'Bitcoin', 'bitcoin', String(sats / 1e8))]
}

// ── NEAR (saldo nativo) vía RPC público ───────────────────────────────
export async function fetchNearWallet(w: Wallet): Promise<SourcePosition[]> {
  const response = await fetch('https://rpc.mainnet.near.org', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'query',
      params: { request_type: 'view_account', finality: 'final', account_id: w.address },
    }),
    signal: AbortSignal.timeout(20_000),
  })
  const body = (await response.json()) as { result?: { amount: string; locked: string } }
  if (!body.result) throw new Error(`NEAR: no se pudo leer ${w.address}`)
  const yocto = BigInt(body.result.amount) + BigInt(body.result.locked)
  const near = Number(yocto / 10n ** 18n) / 1e6
  return [btcLike(w, 'NEAR', 'NEAR', 'near', String(near))]
}

// ── MultiversX (EGLD nativo) ──────────────────────────────────────────
export async function fetchMvxWallet(w: Wallet): Promise<SourcePosition[]> {
  const body = (await getJson(`https://api.multiversx.com/accounts/${w.address}`)) as { balance?: string }
  if (body.balance === undefined) throw new Error(`MultiversX: no se pudo leer ${w.address}`)
  const egld = Number(BigInt(body.balance) / 10n ** 12n) / 1e6
  return [btcLike(w, 'EGLD', 'MultiversX EGLD', 'elrond-erd-2', String(egld))]
}

function btcLike(w: Wallet, symbol: string, name: string, coingeckoId: string, quantity: string): SourcePosition {
  return {
    accountKey: w.accountKey,
    accountName: w.name,
    provider: w.provider,
    address: w.address,
    key: `${w.provider}:${w.address}:${symbol}`,
    symbol,
    name,
    category: 'crypto',
    currency: 'USD',
    quantity,
    price: null,
    priceSource: 'coingecko',
    priceRef: coingeckoId,
  }
}

export async function fetchWallet(w: Wallet): Promise<SourcePosition[]> {
  switch (w.provider) {
    case 'zerion':
      return fetchZerionWallet(w)
    case 'btc':
      return fetchBtcWallet(w)
    case 'near':
      return fetchNearWallet(w)
    case 'mvx':
      return fetchMvxWallet(w)
    default:
      throw new Error(`proveedor de wallet desconocido: ${w.provider}`)
  }
}

export const ZERION_SPACING_MS = 1500
export { sleep }
