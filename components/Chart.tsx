'use client'

import { type Key, useId, useMemo, useState } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

type Series = { key: string; label: string; color: string }
type Row = { date: string } & Record<string, number | string | null>

const WINDOWS = [
  { id: '30D', days: 30 },
  { id: '90D', days: 90 },
  { id: '1Y', days: 365 },
  { id: 'Todo', days: null },
] as const

function fmt(v: number, unit: 'usd' | 'pct'): string {
  // Formato argentino y corto, para que la etiqueta entre en el eje sin partirse: "1,6 M", "800 k".
  const n = (x: number, d: number) => x.toLocaleString('es-AR', { maximumFractionDigits: d })
  if (unit === 'pct') return `${n(v * 100, 1)}\u00a0%`
  const abs = Math.abs(v)
  if (abs >= 1e6) return `${n(v / 1e6, 2)}\u00a0M`
  if (abs >= 1e3) return `${n(v / 1e3, abs >= 1e4 ? 0 : 1)}\u00a0k`
  return n(v, 0)
}

export function Chart({
  data,
  series,
  stacked = false,
  unit = 'usd',
  height = 260,
}: {
  data: Row[]
  series: Series[]
  stacked?: boolean
  unit?: 'usd' | 'pct'
  height?: number
}) {
  const [win, setWin] = useState<(typeof WINDOWS)[number]['id']>('Todo')
  const gid = useId().replace(/:/g, '')
  const visible = useMemo(() => {
    const w = WINDOWS.find((x) => x.id === win)
    if (!w?.days || data.length === 0) return data
    const last = Date.parse(data[data.length - 1]!.date)
    return data.filter((r) => Date.parse(r.date) >= last - w.days! * 86_400_000)
  }, [data, win])

  if (data.length === 0) {
    return <p className="muted py-10 text-center text-sm">Sin datos todavía. La serie comienza con el primer cierre diario.</p>
  }

  const first = data[0]!.date
  const last = data[data.length - 1]!.date
  const axis = { fill: 'var(--faint)', fontSize: 10, letterSpacing: '0.06em' }
  const common = (
    <>
      <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" vertical={false} />
      <XAxis dataKey="date" tick={axis} tickLine={false} axisLine={false} minTickGap={48} tickMargin={8} />
      <YAxis tickFormatter={(v: number) => fmt(v, unit)} tick={axis} tickLine={false} axisLine={false} width={52} />
      <Tooltip
        cursor={{ stroke: 'var(--faint)', strokeDasharray: '2 3' }}
        contentStyle={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 6, fontSize: 12, color: 'var(--ink)' }}
        labelStyle={{ color: 'var(--muted)', fontSize: 11 }}
        formatter={(v) => (typeof v === 'number' ? (unit === 'pct' ? `${(v * 100).toLocaleString('es-AR', { maximumFractionDigits: 2 })}\u00a0%` : `USD\u00a0${v.toLocaleString('es-AR', { maximumFractionDigits: 0 })}`) : String(v))}
      />
    </>
  )
  // Un punto solo en el último dato; con menos de tres puntos se marcan todos.
  const endDot = (color: string) => (p: { index?: number; cx?: number; cy?: number; key?: Key | null }) =>
    (p.index === visible.length - 1 || visible.length < 3) && p.cx != null && p.cy != null
      ? <circle key={p.key ?? undefined} cx={p.cx} cy={p.cy} r={3.5} fill={color} stroke="var(--card)" strokeWidth={2} />
      : <g key={p.key ?? undefined} />

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-[11px] text-[var(--faint)]">
          Datos desde {first} hasta {last} ({data.length} {data.length === 1 ? 'día' : 'días'})
        </span>
        <div className="flex gap-1 text-xs">
          {WINDOWS.map((w) => (
            <button
              key={w.id}
              onClick={() => setWin(w.id)}
              aria-pressed={win === w.id}
              className={`rounded-[5px] px-2 py-1 ${win === w.id ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent)]' : 'muted hover:text-[var(--accent)]'}`}
            >
              {w.id}
            </button>
          ))}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={visible} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            {series.map((s) => {
              // En series negativas (deudas) el área cuelga del 0 hacia abajo: el degradé se invierte para que nazca de la línea.
              const neg = !stacked && visible.every((r) => r[s.key] == null || Number(r[s.key]) <= 0)
              const [top, bottom] = stacked ? [0.7, 0.45] : neg ? [0, 0.22] : [0.22, 0]
              return (
                <linearGradient key={s.key} id={`${gid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" style={{ stopColor: s.color, stopOpacity: top }} />
                  <stop offset="100%" style={{ stopColor: s.color, stopOpacity: bottom }} />
                </linearGradient>
              )
            })}
          </defs>
          {common}
          {series.map((s) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stackId={stacked ? '1' : undefined}
              stroke={s.color}
              strokeWidth={stacked ? 1 : 2}
              fill={`url(#${gid}-${s.key})`}
              dot={stacked ? false : endDot(s.color)}
              activeDot={{ r: 4, stroke: 'var(--card)', strokeWidth: 2 }}
              connectNulls
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
