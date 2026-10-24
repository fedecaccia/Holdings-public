// Motivo corto de un error de fuente para el aviso del dashboard (el detalle completo queda en sync_runs).
export function shortReason(detail: string) {
  const alchemy = detail.match(/^(\d+) wallets por Alchemy/)
  if (alchemy) return `${alchemy[1]} wallets de Zerion valuadas por Alchemy`
  const host = /zerion/i.test(detail) ? 'Zerion' : detail.split(' ')[0]
  if (detail.includes('cuota agotada') || detail.includes('cuota de pedidos agotada')) return `${host} sin cuota diaria`
  if (detail.includes('demasiados pedidos')) return `${host} limitó pedidos`
  if (detail.startsWith('sin tiempo')) return 'Sin tiempo en el cierre'
  // Sin encabezados, sin los segundos que agrega tryRun y sin el nombre de la wallet, así se agrupan.
  const text = detail
    .split(/ ratelimit|\n/)[0]!
    .replace(/\s*\([\d.]+\s*s\)$/, '')
    .replace(/ para .*$/, '')
    .replace(/ leer .*$/, ' leer')
    .trim()
  return text.length > 60 ? `${text.slice(0, 57)}…` : text || 'Error sin detalle'
}

type Issue = { reason: string; sources: string[] }

/** Aviso de una sola línea; el detalle por fuente se despliega a pedido. */
export function SyncNotice({ stale, issues }: { stale: number; issues: Issue[] }) {
  if (stale === 0 && issues.length === 0) return null
  const summary = [stale > 0 ? `${stale} ${stale === 1 ? 'activo' : 'activos'} sin precio nuevo` : '', ...issues.map((i) => i.reason)]
  return (
    <details className="card group border-l-2 border-l-[var(--warn)] px-4 py-2.5 text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
        <span className="shrink-0 rounded-[3px] bg-[var(--warn-soft)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--warn)]">Aviso</span>
        <span className="min-w-0 truncate">{summary.filter(Boolean).join(' · ')}</span>
        <span className="muted ml-auto shrink-0 text-xs group-open:hidden">Ver más</span>
      </summary>
      <ul className="muted mt-2 space-y-1 text-xs break-words">
        {stale > 0 && <li>Valuados con el precio del cierre anterior; se actualizan solos en el próximo cierre que responda la fuente.</li>}
        {issues.map((i) => (
          <li key={i.reason}>
            <span className="text-[var(--heading)]">{i.reason}</span>
            {i.sources.some((name) => !i.reason.includes(name)) && `: ${i.sources.join(', ')}`}
          </li>
        ))}
      </ul>
    </details>
  )
}
