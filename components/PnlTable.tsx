'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'

import { AssetLogo } from '@/components/AssetLogo'
import { Pnl } from '@/components/Pnl'
import { label, usd } from '@/lib/format'

export type PnlRow = { id: string; name: string; symbol: string; meta: { protocol?: unknown; chain?: unknown }; category: string; account: string; detail: string; cost: number; value: number }

type Key = 'name' | 'category' | 'account' | 'cost' | 'value' | 'pnl' | 'ret'
const COLUMNS: { key: Key; label: string; numeric?: boolean; wide?: boolean }[] = [
  { key: 'name', label: 'Activo' },
  { key: 'category', label: 'Tipo', wide: true },
  { key: 'account', label: 'Cuenta', wide: true },
  { key: 'cost', label: 'Costo', numeric: true, wide: true },
  { key: 'value', label: 'Valor', numeric: true, wide: true },
  { key: 'pnl', label: 'Resultado', numeric: true },
  { key: 'ret', label: 'Rendimiento', numeric: true, wide: true },
]

const sortValue = (r: PnlRow, k: Key): number | string => {
  if (k === 'name') return r.name.toLowerCase()
  if (k === 'category') return label(r.category)
  if (k === 'account') return r.account
  if (k === 'pnl') return r.value - r.cost
  if (k === 'ret') return r.cost ? (r.value - r.cost) / Math.abs(r.cost) : 0
  return r[k]
}

const plain = (t: string) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
const same = (a: string, b: string) => plain(a) === plain(b)

/** Tabla del detalle de PnL: orden por columna y filtro por tipo y cuenta. Los totales siguen al filtro; la
 *  participación es siempre sobre el resultado total de la cartera. */
export function PnlTable({ rows }: { rows: PnlRow[] }) {
  const [category, setCategory] = useState('')
  const [account, setAccount] = useState('')
  const [sort, setSort] = useState<{ key: Key | 'impact'; desc: boolean }>({ key: 'impact', desc: true })

  const categories = useMemo(() => [...new Set(rows.map((r) => r.category))].sort((a, b) => label(a).localeCompare(label(b))), [rows])
  const accounts = useMemo(() => [...new Set(rows.map((r) => r.account))].sort((a, b) => a.localeCompare(b)), [rows])
  const overall = rows.reduce((s, r) => s + r.value - r.cost, 0)
  const maxAbs = rows.reduce((m, r) => Math.max(m, Math.abs(r.value - r.cost)), 0)

  const shown = useMemo(() => {
    const list = rows.filter((r) => (!category || r.category === category) && (!account || r.account === account))
    const get = (r: PnlRow) => (sort.key === 'impact' ? Math.abs(r.value - r.cost) : sortValue(r, sort.key))
    return list.sort((a, b) => {
      const x = get(a)
      const y = get(b)
      const c = typeof x === 'string' ? x.localeCompare(String(y)) : x - (y as number)
      return sort.desc ? -c : c
    })
  }, [rows, category, account, sort])

  const cost = shown.reduce((s, r) => s + r.cost, 0)
  const value = shown.reduce((s, r) => s + r.value, 0)
  const share = (pnl: number) => (overall !== 0 ? `${Math.round((pnl / Math.abs(overall)) * 100) || 0} %` : '—')

  const toggle = (key: Key) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: !!COLUMNS.find((c) => c.key === key)?.numeric }))
  const arrow = (key: Key) => (sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : '')

  return (
    <>
      <div className="mb-4 grid grid-cols-1 gap-2 text-sm sm:flex sm:flex-wrap sm:items-center sm:gap-3">
        <label className="flex items-center justify-between gap-2 sm:justify-start">
          <span className="muted w-14 sm:w-auto">Tipo</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="min-w-0 flex-1 sm:flex-none">
            <option value="">Todos</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {label(c)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center justify-between gap-2 sm:justify-start">
          <span className="muted w-14 sm:w-auto">Cuenta</span>
          <select value={account} onChange={(e) => setAccount(e.target.value)} className="min-w-0 flex-1 sm:flex-none">
            <option value="">Todas</option>
            {accounts.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        {/* En el celular las columnas de orden no se ven: el orden se elige acá. */}
        <label className="flex items-center justify-between gap-2 sm:hidden">
          <span className="muted w-14">Orden</span>
          <select
            value={`${sort.key}:${sort.desc ? 'desc' : 'asc'}`}
            onChange={(e) => {
              const [key, dir] = e.target.value.split(':')
              setSort({ key: key as Key | 'impact', desc: dir === 'desc' })
            }}
            className="min-w-0 flex-1"
          >
            <option value="impact:desc">Mayor impacto</option>
            <option value="pnl:desc">Mayor resultado</option>
            <option value="pnl:asc">Menor resultado</option>
            <option value="ret:desc">Mayor rendimiento</option>
            <option value="value:desc">Mayor valor</option>
            <option value="category:asc">Tipo</option>
            <option value="name:asc">Activo (A-Z)</option>
          </select>
        </label>
        {(category || account) && (
          <button type="button" className="muted text-left underline sm:ml-auto" onClick={() => (setCategory(''), setAccount(''))}>
            Quitar filtros
          </button>
        )}
      </div>
      <table className="w-full text-sm lg:min-w-[860px]">
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                aria-sort={sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : undefined}
                className={`py-2 ${c.key === 'name' ? '' : 'pl-3'} ${c.numeric ? 'text-right' : ''} ${c.wide ? 'hidden lg:table-cell' : ''}`}
              >
                <button type="button" onClick={() => toggle(c.key)} className="uppercase hover:text-[var(--accent)]">
                  {c.label}
                  {arrow(c.key)}
                </button>
              </th>
            ))}
            <th className="hidden py-2 pl-3 text-right lg:table-cell">Participación</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const pnl = r.value - r.cost
            return (
              <tr key={r.id} className="border-t border-[var(--line)]">
                <td className="py-2">
                  <div className="flex gap-3">
                    <AssetLogo symbol={r.symbol} category={r.category} account={r.account} meta={r.meta} size={30} />
                    <div className="min-w-0">
                      <Link href={`/a/${r.id}`} className="font-medium text-[var(--heading)] hover:text-[var(--accent)]">{r.name}</Link>
                      <div className="muted text-xs lg:hidden">{same(label(r.category), r.account) ? r.account : `${label(r.category)} · ${r.account}`}</div>
                      {r.detail && <div className="muted text-xs">{r.detail}</div>}
                      <div className="muted text-xs tabular-nums lg:hidden">
                        {usd(r.cost)} → {usd(r.value)}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="hidden py-2 pl-3 lg:table-cell">{label(r.category)}</td>
                <td className="muted hidden py-2 pl-3 lg:table-cell">{r.account}</td>
                <td className="num hidden py-2 pl-3 text-right lg:table-cell">{usd(r.cost)}</td>
                <td className="num hidden py-2 pl-3 text-right lg:table-cell">{usd(r.value)}</td>
                <td className="py-2 pl-3 text-right">
                  <Pnl value={r.value} cost={r.cost} className="block lg:hidden" stacked />
                  <span className="num hidden lg:inline">
                    <Pnl value={r.value} cost={r.cost} hidePct />
                  </span>
                  <span className="muted num text-xs lg:hidden">{share(pnl)} del total</span>
                </td>
                <td className="num hidden py-2 pl-3 text-right lg:table-cell">
                  <Pnl value={r.value} cost={r.cost} pctOnly />
                </td>
                <td className="num muted hidden py-2 pl-3 text-right lg:table-cell">
                  {share(pnl)}
                  <Contribution pnl={pnl} max={maxAbs} />
                </td>
              </tr>
            )
          })}
          {shown.length === 0 && (
            <tr className="border-t border-[var(--line)]">
              <td colSpan={8} className="muted py-4 text-center">
                Ningún activo con esos filtros.
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr className="border-t border-[var(--heading)] font-medium text-[var(--heading)]">
            <td className="py-2">
              {category || account ? 'Total filtrado' : 'Total'}
              <div className="muted text-xs font-normal tabular-nums lg:hidden">
                {usd(cost)} → {usd(value)}
              </div>
            </td>
            <td className="hidden lg:table-cell" />
            <td className="hidden lg:table-cell" />
            <td className="num hidden py-2 pl-3 text-right lg:table-cell">{usd(cost)}</td>
            <td className="num hidden py-2 pl-3 text-right lg:table-cell">{usd(value)}</td>
            <td className="py-2 pl-3 text-right">
              <Pnl value={value} cost={cost || null} className="block lg:hidden" stacked />
              <span className="num hidden lg:inline">
                <Pnl value={value} cost={cost || null} hidePct />
              </span>
            </td>
            <td className="num hidden py-2 pl-3 text-right lg:table-cell">
              <Pnl value={value} cost={cost || null} pctOnly />
            </td>
            <td className="num hidden py-2 pl-3 text-right lg:table-cell">{share(value - cost)}</td>
          </tr>
        </tfoot>
      </table>
    </>
  )
}

/** Barra de aporte al resultado: eje al centro, hacia la derecha en verde si suma y hacia la izquierda en rojo si resta,
 *  a escala del mayor resultado de la tabla (en valor absoluto). */
function Contribution({ pnl, max }: { pnl: number; max: number }) {
  if (max === 0) return null
  const w = `${(Math.abs(pnl) / max) * 50}%`
  return (
    <span aria-hidden="true" className="relative ml-auto mt-1.5 block h-1 w-20 bg-[var(--pale)]">
      <span className="absolute -top-0.5 -bottom-0.5 left-1/2 w-px bg-[var(--faint)]" />
      <span
        className="absolute inset-y-0"
        style={pnl >= 0 ? { left: '50%', width: w, background: 'var(--up)' } : { right: '50%', width: w, background: 'var(--down)' }}
      />
    </span>
  )
}
