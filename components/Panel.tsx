import type { ReactNode } from 'react'

// Módulo del tablero: título arriba con su dato al costado y el contenido debajo.
export function Panel({ title, aside, children, className = '' }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card min-w-0 ${className}`}>
      {title && (
        <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-[var(--line)] px-4 py-3 sm:px-5">
          <h2 className="text-sm font-medium">{title}</h2>
          {aside && <div className="muted text-xs">{aside}</div>}
        </header>
      )}
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  )
}
