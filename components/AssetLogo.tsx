import type { CSSProperties } from 'react'

import { Icon } from '@/components/Icon'
import { CATEGORY_COLORS } from '@/lib/format'

// Logos en public/logos: Simple Icons (CC0) y cryptocurrency-icons (CC0), más Ledger y
// MultiversX dibujados a mano. Los que ya son un disco de color llenan el círculo entero.
const FULL = new Set(['usdc', 'aave', 'uni', 'dai', 'nexo', 'multiversx', 'ledger'])
// Fondo suave detrás de los logos de una sola tinta.
const TINT: Record<string, string> = { bitcoin: '#fff4e4', ethereum: '#eef1fc', solana: '#f2eefc', tether: '#ebf7f2' }

/** Logo de un activo por su símbolo. Los tokens envueltos o de rendimiento llevan el logo del subyacente. */
function assetSlug(symbol: string): string | null {
  // aTokens de Aave (aEthWETH, aArbWBTC…): se saca el prefijo para llegar al subyacente.
  const s = symbol.toUpperCase().replace(/^A(ETH|ARB|BAS|OPT|POL|AVA|BNB|SCA|LIN|ZKS)?(?=W?ETH$|WSTETH$|WBTC$|CBBTC$)/, '')
  if (/^(W|CB)?BTC$/.test(s)) return 'bitcoin'
  if (/^(W|ST|WST)?ETH$/.test(s)) return 'ethereum'
  if (/USDC/.test(s)) return 'usdc'
  if (/USDT/.test(s)) return 'tether'
  if (/^S?DAI$/.test(s)) return 'dai'
  const map: Record<string, string> = { SOL: 'solana', NEXO: 'nexo', NEAR: 'near', EGLD: 'multiversx', BNB: 'binance', AAVE: 'aave', UNI: 'uni', AAPL: 'apple', NVDA: 'nvidia' }
  return map[s] ?? null
}

type Badge = { slug?: string; icon?: string; glyph?: string; color?: string; ink?: string }

/** Marca de la plataforma donde está el activo: el protocolo en DeFi, si no la cuenta, si no la red de la wallet. */
function platform(account: string, meta?: { protocol?: unknown; chain?: unknown }): Badge | null {
  const a = `${String(meta?.protocol ?? '')} ${account}`.toLowerCase()
  if (a.includes('maple')) return { glyph: 'M', color: '#111111', ink: '#ff8a3d' }
  if (a.includes('aave')) return { slug: 'aave' }
  if (a.includes('uniswap')) return { slug: 'uni' }
  if (a.includes('nexo')) return { slug: 'nexo' }
  if (a.includes('lemon')) return { glyph: 'L', color: '#c6f135', ink: '#0a1f3c' }
  if (/\biol\b|invertir/.test(a)) return { glyph: 'I', color: '#00a79d', ink: '#fff' }
  if (/ibkr|interactive/.test(a)) return { slug: 'interactive-brokers' }
  if (a.includes('binance')) return { slug: 'binance' }
  if (a.includes('ledger')) return { slug: 'ledger' }
  if (/banco|santander|macro|galicia/.test(a)) return { icon: 'banco' }
  const chain = String(meta?.chain ?? '').toLowerCase()
  if (chain) {
    const bySlug: Record<string, string> = { ethereum: 'ethereum', solana: 'solana', near: 'near', multiversx: 'multiversx', bitcoin: 'bitcoin' }
    return bySlug[chain] ? { slug: bySlug[chain] } : { icon: 'wallet' }
  }
  return null
}

// Tickers sin logo: monograma (como mucho cuatro letras). Lo que no es un ticker cotizado lleva el ícono de su categoría.
const TICKER_CATEGORIES = new Set(['crypto', 'stablecoin', 'defi', 'acciones', 'cedears'])

function Mark({ slug, icon, glyph, color, ink, size, category }: Badge & { size: number; category: string }) {
  const tint = CATEGORY_COLORS[category] ?? 'var(--accent)'
  if (slug) {
    const full = FULL.has(slug)
    return (
      <span className={`logo ${full ? 'logo-full' : ''}`} style={{ width: size, height: size, background: TINT[slug] }}>
        <img src={`/logos/${slug}.svg`} alt="" width={size} height={size} />
      </span>
    )
  }
  if (glyph) {
    // En la insignia no entra más de una letra.
    const text = size < 20 ? glyph.slice(0, 1) : glyph
    const fontSize = Math.round(size * (text.length > 2 ? 0.3 : text.length > 1 ? 0.36 : 0.46))
    return (
      <span className="logo logo-full font-semibold" style={{ width: size, height: size, background: color ?? `color-mix(in srgb, ${tint} 14%, var(--card))`, color: ink ?? tint, fontSize }}>
        {text}
      </span>
    )
  }
  return (
    <span className="logo" style={{ width: size, height: size, background: `color-mix(in srgb, ${tint} 12%, var(--card))`, color: tint } as CSSProperties}>
      <Icon name={icon ?? category} size={Math.round(size * 0.5)} />
    </span>
  )
}

/** Logo del activo en un círculo, con la plataforma (cuenta, protocolo o red) en una insignia abajo a la derecha. */
export function AssetLogo({
  symbol,
  category,
  account,
  meta,
  size = 32,
}: {
  symbol: string
  category: string
  account: string
  meta?: { protocol?: unknown; chain?: unknown }
  size?: number
}) {
  const slug = assetSlug(symbol)
  const ticker = symbol.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase()
  const main: Badge = slug
    ? { slug }
    : category === 'cash' && symbol.toUpperCase() === 'USD'
      ? { icon: 'stablecoin' }
      : TICKER_CATEGORIES.has(category) && ticker
        ? { glyph: ticker }
        : {}
  const badge = platform(account, meta)
  // Sin insignia cuando repetiría el logo principal (BTC en el Ledger de BTC sí la lleva: son cosas distintas).
  const showBadge = badge && !(badge.slug && badge.slug === slug)
  return (
    <span className="relative inline-flex shrink-0" aria-hidden="true">
      <Mark {...main} size={size} category={category} />
      {showBadge && (
        <span className="logo-badge">
          <Mark {...badge} size={Math.round(size * 0.46)} category={category} />
        </span>
      )}
    </span>
  )
}

/** Ícono de la categoría en su color. */
export function CategoryIcon({ category, size = 15 }: { category: string; size?: number }) {
  return <Icon name={category} size={size} style={{ color: CATEGORY_COLORS[category] ?? 'var(--faint)' }} />
}
