import Link from 'next/link'

import { CategoryIcon } from '@/components/AssetLogo'
import { Icon } from '@/components/Icon'
import { label, usd } from '@/lib/format'

export type CategoryTotal = { category: string; value: number }

// Lateral de categorías: neto arriba y cada tipo con su peso sobre los activos.
// En pantallas chicas se reemplaza por una fila de fichas que se desliza.
export function CategoryRail({ cats, net, current }: { cats: CategoryTotal[]; net: number; current?: string }) {
  const assets = cats.filter((c) => c.category !== 'deuda').reduce((s, c) => s + c.value, 0)
  const share = (v: number) => (assets > 0 && v > 0 ? `${((v / assets) * 100).toFixed(1).replace('.', ',')} %` : '')
  const item = (on: boolean) =>
    `flex items-center justify-between gap-2 rounded-[5px] px-2.5 py-2 text-[13px] ${on ? 'bg-[var(--accent-soft)] font-medium text-[var(--heading)]' : 'hover:text-[var(--accent)]'}`
  return (
    <>
      <aside className="sticky top-[calc(var(--header-h)+20px)] hidden max-h-[calc(100vh-var(--header-h)-36px)] self-start overflow-y-auto rounded-md border border-[var(--line)] bg-[var(--card)] p-3 lg:block">
        <p className="eyebrow px-2.5 text-[9.5px]">Patrimonio</p>
        <p className="px-2.5 pt-1 pb-3">
          <span className="muted block text-[11px]">Neto</span>
          <span className="display num text-[22px]">{usd(net)}</span>
        </p>
        <nav aria-label="Categorías" className="grid gap-0.5">
          <Link href="/" className={item(!current)} aria-current={!current ? 'page' : undefined}>
            <span className="flex items-center gap-2.5"><Icon name="todo" size={15} className="text-[var(--heading)]" />Todo</span>
            <span className="muted num text-[11px]">100&nbsp;%</span>
          </Link>
          {cats.map((c) => (
            <Link key={c.category} href={`/c/${c.category}`} className={item(current === c.category)} aria-current={current === c.category ? 'page' : undefined}>
              <span className="flex items-center gap-2.5">
                <CategoryIcon category={c.category} />
                {label(c.category)}
              </span>
              <span className={`num text-[11px] ${c.category === 'deuda' ? 'down' : 'muted'}`}>{c.category === 'deuda' ? usd(c.value) : share(c.value)}</span>
            </Link>
          ))}
        </nav>
        <p className="mt-4 border-t border-[var(--line)] px-2.5 pt-3 text-[10.5px] leading-relaxed text-[var(--faint)]">
          Montos en USD. Lo que está en pesos se convierte al dólar del día.
        </p>
      </aside>
      <nav aria-label="Categorías" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:hidden">
        <Link href="/" aria-current={!current ? 'page' : undefined} className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs ${!current ? 'border-[var(--heading)] font-medium text-[var(--heading)]' : 'muted border-[var(--line)] bg-[var(--card)]'}`}>
          <Icon name="todo" size={13} />Todo
        </Link>
        {cats.filter((c) => c.category !== 'deuda').map((c) => (
          <Link
            key={c.category}
            href={`/c/${c.category}`}
            aria-current={current === c.category ? 'page' : undefined}
            className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs ${current === c.category ? 'border-[var(--heading)] font-medium text-[var(--heading)]' : 'muted border-[var(--line)] bg-[var(--card)]'}`}
          >
            <CategoryIcon category={c.category} size={13} />
            {label(c.category)} <span className="num">{share(c.value)}</span>
          </Link>
        ))}
      </nav>
    </>
  )
}
