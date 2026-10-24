import Link from 'next/link'

// Migas de pan arriba de cada pantalla de detalle, en texto chico: "Resumen › Cripto".
export function Breadcrumb({ items }: { items: { href?: string; label: string }[] }) {
  return (
    <nav aria-label="Migas de pan" className="mb-2 flex flex-wrap items-center gap-2 text-xs">
      {items.map((it, i) => (
        <span key={i} className="flex items-center gap-2">
          {i > 0 && <span className="text-[var(--faint)]">›</span>}
          {it.href ? (
            <Link href={it.href} className="crumb">
              {it.label}
            </Link>
          ) : (
            <span className="font-medium text-[var(--heading)]">{it.label}</span>
          )}
        </span>
      ))}
    </nav>
  )
}
