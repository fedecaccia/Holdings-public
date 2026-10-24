'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

// Íconos de trazo fino para la barra inferior de mobile.
const ICONS: Record<string, string> = {
  '/': 'M3 11.5 12 4l9 7.5M5.5 10v9.5h13V10',
  '/flujo': 'M4 8h13m0 0-3.5-3.5M17 8l-3.5 3.5M20 16H7m0 0 3.5-3.5M7 16l3.5 3.5',
  '/pnl': 'M4 19.5h16M6.5 16V11m5 5V6.5m5 9.5v-7',
  '/riesgos': 'M12 4 3 19.5h18L12 4Zm0 6v4.5m0 2.5v.5',
  '/insights': 'M9.5 18h5M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3Z',
  '/fundamentales': 'M4 19.5h16M6 16l4-4.5 3 3L19 7m0 0h-4m4 0v4',
  '/onboarding': 'M5 7h14M5 12h14M5 17h14M9 5v4m6 1v4m-4 1v4',
}

const LINKS = [
  { href: '/', label: 'Resumen' },
  { href: '/flujo', label: 'Flujo de fondos', short: 'Flujo' },
  { href: '/pnl', label: 'PnL' },
  { href: '/riesgos', label: 'Riesgos' },
  { href: '/insights', label: 'Insights' },
  { href: '/fundamentales', label: 'Fundamentales', short: 'Valuación' },
  { href: '/onboarding', label: 'Configuración', short: 'Ajustes' },
]

// Menú principal: en el encabezado desde sm, con una línea azul debajo de la sección actual;
// en mobile, barra fija abajo con íconos.
export function Nav({ bottom = false }: { bottom?: boolean }) {
  const path = usePathname()
  const isOn = (href: string) =>
    href === '/'
      ? path === '/' || path === '/variacion' || path.startsWith('/c/') || path.startsWith('/a/')
      : path.startsWith(href)
  if (path === '/login') return null
  if (bottom) {
    return (
      <nav
        aria-label="Principal"
        className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-7 border-t border-[var(--line)] bg-[var(--card)] sm:hidden"
      >
        {LINKS.map((l) => {
          const on = isOn(l.href)
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={on ? (path === l.href ? 'page' : 'true') : undefined}
              className={`flex flex-col items-center gap-1 py-2.5 text-[10px] ${on ? 'font-medium text-[var(--accent)]' : 'muted'}`}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d={ICONS[l.href]} />
              </svg>
              {l.short ?? l.label}
            </Link>
          )
        })}
      </nav>
    )
  }
  return (
    <nav aria-label="Principal" className="hidden gap-4 text-[13px] sm:flex md:gap-7">
      {LINKS.map((l) => {
        const on = isOn(l.href)
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={on ? (path === l.href ? 'page' : 'true') : undefined}
            className={`inline-block whitespace-nowrap py-1.5 ${on ? 'border-b border-[var(--accent)] text-[var(--heading)]' : 'muted hover:text-[var(--accent)]'}`}
          >
            {l.label}
          </Link>
        )
      })}
    </nav>
  )
}
