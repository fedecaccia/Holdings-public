import type { Metadata, Viewport } from 'next'
import { Inter, Source_Serif_4 } from 'next/font/google'
import Link from 'next/link'
import type { ReactNode } from 'react'

import { Nav } from '@/components/Nav'

import './globals.css'

// Fuentes: Inter para la interfaz, Source Serif 4 para títulos y cifras principales.
const ui = Inter({ subsets: ['latin'], variable: '--font-ui', display: 'swap' })
const display = Source_Serif_4({ subsets: ['latin'], variable: '--font-display', display: 'swap' })

export const metadata: Metadata = { title: 'Holdings', robots: { index: false, follow: false } }
export const viewport: Viewport = { themeColor: '#0a1f3c' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es" className={`${ui.variable} ${display.variable}`}>
      <body>
        <div className="bg-[var(--navy)] text-[11px] tracking-wide text-[var(--band-ink)]">
          <p className="mx-auto max-w-6xl px-4 py-2">
            <span className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-[#81aaff] align-middle" />
            Patrimonio consolidado en USD<span className="hidden sm:inline"> · cierre diario 21:15 (hora argentina)</span>
          </p>
        </div>
        {/* Fijo arriba; su alto está en --header-h (globals.css), que usan el lateral y el scroll-padding. */}
        <header className="sticky top-0 z-30 border-b border-[var(--line)] bg-[var(--card)]">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4">
            <Link href="/" className="inline-flex items-center gap-2 text-xl font-semibold tracking-tight text-[var(--heading)]">
              <span className="display inline-grid h-7 w-7 place-items-center rounded-[5px] bg-[var(--heading)] text-base text-[var(--card)]">H</span>
              <span>holdings<span className="text-[var(--accent)]">.</span></span>
            </Link>
            <Nav />
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 pt-8 pb-28 sm:pb-16">{children}</main>
        <Nav bottom />
      </body>
    </html>
  )
}
