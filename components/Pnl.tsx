import { pct, usd } from '@/lib/format'

/** PnL visual: valor de hoy contra el costo conocido. Solo para mirar, no se guarda. `stacked` pone el % en otra línea;
 *  `hidePct` muestra solo el monto y `pctOnly` solo el porcentaje (para tablas con una columna para cada uno). */
export function Pnl({
  value,
  cost,
  className = '',
  stacked = false,
  hidePct = false,
  pctOnly = false,
}: {
  value: number
  cost: number | null
  className?: string
  stacked?: boolean
  hidePct?: boolean
  pctOnly?: boolean
}) {
  if (cost === null || cost === 0) return <span className={`muted ${className}`}>—</span>
  const diff = value - cost
  // Sin diferencia (por ejemplo, un inmueble que vale lo invertido): gris, sin signo ni color.
  if (Math.abs(diff) < 0.5) return <span className={`muted num ${className}`}>{pctOnly ? pct(0) : usd(0)}</span>
  const ret = pct(diff / Math.abs(cost))
  const tone = `${diff >= 0 ? 'up' : 'down'} num ${className}`
  if (pctOnly) return <span className={tone}>{ret}</span>
  return (
    <span className={tone}>
      {diff >= 0 ? '+' : ''}
      {usd(diff)}
      {hidePct ? null : stacked ? <span className="block text-xs">{ret}</span> : <> ({ret})</>}
    </span>
  )
}
