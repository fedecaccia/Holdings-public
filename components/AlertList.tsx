import Link from 'next/link'

import { Breadcrumb } from '@/components/Breadcrumb'
import { Panel } from '@/components/Panel'
import { type AlertRow, isResearch, type Kind, listAlerts, SEVERITIES, SEVERITY_LABEL, type Severity } from '@/lib/alerts'

// Colores de criticidad con la paleta del sitio: crítica en rojo, alta en ámbar, media en azul, baja en gris.
const TONE: Record<Severity, string> = {
  critica: 'bg-[var(--down)] text-[var(--card)]',
  alta: 'bg-[var(--warn-soft)] text-[var(--warn)] ring-1 ring-[var(--warn)]',
  media: 'bg-[var(--accent-soft)] text-[var(--accent)]',
  baja: 'bg-[var(--pale)] text-[var(--muted)] ring-1 ring-[var(--line)]',
}

const COPY: Record<Kind, { title: string; intro: string; empty: string; link?: { href: string; label: string } }> = {
  riesgo: {
    title: 'Riesgos',
    intro:
      'Lo que encuentra la rutina diaria de riesgos en noticias y fundamentals de cada activo invertible. Cada día revisa los vigentes y depreca los que ya no valen. Los de criticidad alta o crítica llegan también por Telegram.',
    empty: 'Ningún riesgo vigente. La rutina corre una vez por día.',
  },
  insight: {
    title: 'Insights',
    intro:
      'Recomendaciones de rebalanceo y oportunidades de compra de la rutina diaria de insights. Cada día revisa los vigentes y depreca los que ya no valen. Los de criticidad alta o crítica llegan también por Telegram.',
    empty: 'Ningún insight vigente. La rutina corre una vez por día.',
    link: { href: '/fundamentales', label: 'Fundamentales del mes' },
  },
  fundamental: {
    title: 'Fundamentales',
    intro:
      'La rutina mensual analiza balances, proyecciones y valuación de las empresas en seguimiento. Una alerta por empresa con su valor justo, la zona de compra y el veredicto; la de cada mes reemplaza a la anterior. La rutina de insights avisa cuando un precio entra en zona. Arriba, el resumen del mes de los reportes públicos de bancos y gestoras grandes.',
    empty: 'Todavía no hay valuaciones. La rutina corre una vez por mes.',
  },
}

const AR = 'America/Argentina/Buenos_Aires'
const shortDay = (iso: string) => new Date(iso).toLocaleDateString('es-AR', { timeZone: AR, day: 'numeric', month: 'short' })
const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function SeverityBadge({ severity, muted = false }: { severity: Severity; muted?: boolean }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-[4px] px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] ${muted ? TONE.baja : TONE[severity]}`}
    >
      {SEVERITY_LABEL[severity]}
    </span>
  )
}

const Chevron = () => (
  <span aria-hidden className="w-3 shrink-0 text-[var(--faint)] transition-transform group-open:rotate-90">
    ›
  </span>
)

/** Una línea (criticidad y título) que se despliega con el detalle, como el aviso del dashboard. */
function Item({ a }: { a: AlertRow }) {
  const old = a.deprecated_at !== null
  return (
    <details className="group border-b border-[var(--line)] last:border-b-0">
      <summary className="flex cursor-pointer list-none items-center gap-2 py-3 text-sm [&::-webkit-details-marker]:hidden">
        <Chevron />
        <SeverityBadge severity={a.severity} muted={old} />
        <span className={`min-w-0 flex-1 line-clamp-2 group-open:line-clamp-none sm:truncate sm:group-open:whitespace-normal ${old ? 'muted' : 'text-[var(--heading)]'}`}>
          {a.title}
        </span>
        <span className="muted shrink-0 text-xs">{shortDay(a.created_at)}</span>
      </summary>
      <div className={`pb-4 pl-5 ${old ? 'text-[var(--muted)]' : ''}`}>
        {old && (
          <p className="mb-2 text-xs">
            Deprecado el {shortDay(a.deprecated_at!)}
            {a.deprecated_reason && <>: {a.deprecated_reason}</>}
          </p>
        )}
        {(a.symbol || a.asset_name || a.action) && (
          <p className="mb-1 flex flex-wrap gap-x-2 text-xs">
            {(a.symbol || a.asset_name) && (
              <span className="font-medium">
                {a.symbol ?? a.asset_name}
                {a.symbol && a.asset_name && <span className="muted font-normal"> · {a.asset_name}</span>}
              </span>
            )}
            {a.action && (
              <span className="muted">
                · Acción: <span className="font-medium">{a.action}</span>
              </span>
            )}
          </p>
        )}
        <p className="whitespace-pre-line text-sm leading-relaxed">{a.body}</p>
        {a.sources.length > 0 && (
          <p className="muted mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {a.sources.map((s, i) => (
              <a key={i} href={s.url} target="_blank" rel="noreferrer" className="break-all underline decoration-[var(--line)] underline-offset-2 hover:text-[var(--accent)]">
                {s.title || host(s.url)}
              </a>
            ))}
          </p>
        )}
      </div>
    </details>
  )
}

export async function AlertList({ kind }: { kind: Kind }) {
  const alerts = await listAlerts(kind, 365)
  const copy = COPY[kind]
  const order = [...SEVERITIES].reverse()
  // Vigentes arriba, de la más grave a la menos (y la más nueva primero); deprecadas abajo, la última deprecada primero.
  const vigentes = alerts.filter((a) => a.deprecated_at === null)
  // El resumen de research más nuevo va aparte, abierto, arriba de las valuaciones (la lista viene de la más nueva a la más vieja).
  const research = vigentes.find(isResearch)
  const active = vigentes.filter((a) => a !== research).sort((x, y) => order.indexOf(x.severity) - order.indexOf(y.severity))
  const old = alerts.filter((a) => a.deprecated_at !== null).sort((x, y) => +new Date(y.deprecated_at!) - +new Date(x.deprecated_at!))

  return (
    <div className="space-y-8">
      <Breadcrumb items={[{ href: '/', label: 'Resumen' }, { label: copy.title }]} />
      <section>
        <h1 className="mb-2 text-3xl">{copy.title}</h1>
        <p className="muted mb-6 max-w-2xl text-sm">
          {copy.intro}
          {copy.link && (
            <>
              {' '}
              <Link href={copy.link.href} className="crumb">
                {copy.link.label} ›
              </Link>
            </>
          )}
        </p>
        <div className="space-y-6">
          {research && (
            <Panel title="Research del mes" aside={shortDay(research.created_at)}>
              <h2 className="mb-2 text-base text-[var(--heading)]">{research.title}</h2>
              <p className="whitespace-pre-line text-sm leading-relaxed">{research.body}</p>
              {research.sources.length > 0 && (
                <p className="muted mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  {research.sources.map((s, i) => (
                    <a key={i} href={s.url} target="_blank" rel="noreferrer" className="break-all underline decoration-[var(--line)] underline-offset-2 hover:text-[var(--accent)]">
                      {s.title || host(s.url)}
                    </a>
                  ))}
                </p>
              )}
            </Panel>
          )}
          {active.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
              {order.map((s) => (
                <span key={s} className="flex items-center gap-1.5">
                  <SeverityBadge severity={s} />
                  <span className="num">{active.filter((a) => a.severity === s).length}</span>
                </span>
              ))}
            </div>
          )}
          <Panel title="Vigentes" aside={`${active.length} ${active.length === 1 ? 'alerta' : 'alertas'}`}>
            {active.length === 0 ? (
              <p className="muted text-sm">{copy.empty}</p>
            ) : (
              <div className="-my-4 sm:-my-5">
                {active.map((a) => (
                  <Item key={a.id} a={a} />
                ))}
              </div>
            )}
          </Panel>
          {old.length > 0 && (
            <details className="card group/old">
              <summary className="muted flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm sm:px-5 [&::-webkit-details-marker]:hidden">
                <span aria-hidden className="w-3 shrink-0 text-[var(--faint)] transition-transform group-open/old:rotate-90">
                  ›
                </span>
                <span>Deprecados</span>
                <span className="ml-auto text-xs">{old.length}</span>
              </summary>
              <div className="border-t border-[var(--line)] px-4 sm:px-5">
                {old.map((a) => (
                  <Item key={a.id} a={a} />
                ))}
              </div>
            </details>
          )}
        </div>
      </section>
    </div>
  )
}
