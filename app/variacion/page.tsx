import Link from 'next/link'

import { AssetLogo } from '@/components/AssetLogo'
import { Breadcrumb } from '@/components/Breadcrumb'
import { assetLine, pct, usd } from '@/lib/format'
import { dailyChange } from '@/lib/queries'

export const dynamic = 'force-dynamic'

// Variación vs. cierre anterior, activo por activo. Se calcula al abrir la página con los dos últimos snapshots, no se guarda.
// El reparto entre efecto precio y efecto cantidad está en dailyChange() (lib/queries.ts), que también usa la API.
export default async function DailyChange() {
  const { rows: data, from, to } = await dailyChange()

  const moved = data.filter((r) => Math.abs(r.change) >= 0.5).sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
  const still = data.filter((r) => Math.abs(r.change) < 0.5)
  const sum = (k: 'v0' | 'v1' | 'change' | 'byQty' | 'byPrice') => data.reduce((s, r) => s + r[k], 0)
  const [before, after, total, byQty, byPrice] = [sum('v0'), sum('v1'), sum('change'), sum('byQty'), sum('byPrice')]
  const maxAbs = moved.reduce((m, r) => Math.max(m, Math.abs(r.change)), 0)

  return (
    <div className="space-y-8">
      <Breadcrumb items={[{ href: '/', label: 'Resumen' }, { label: 'Variación diaria' }]} />
      <section className="overflow-x-auto">
        <h1 className="mb-2 text-3xl">Variación vs. cierre anterior</h1>
        {from === null ? (
          <p className="muted text-sm">Hace falta un segundo cierre para comparar. Se calcula sola desde el próximo cierre.</p>
        ) : (
          <>
            <p className="muted max-w-2xl text-sm">
              Qué movió el patrimonio neto entre el cierre del {from} y el del {to}, de la mayor variación a la menor. Incluye las deudas.
            </p>
            <p className="figure mt-4">
              <span className="cur">USD</span>
              <span className={tone(total)}>
                {total >= 0.5 ? '+' : ''}
                {usd(total).replace('USD ', '')}
              </span>
            </p>
            <p className="mt-3 text-xs">
              <span className={`num ${tone(total)}`}>{pct(total / Math.abs(before || 1))}</span>{' '}
              <span className="muted num">neto {usd(before)} → {usd(after)}</span>
            </p>
            <dl className="mt-6 mb-8 grid gap-px overflow-hidden rounded-[8px] border border-[var(--line)] bg-[var(--line)] sm:grid-cols-2">
              <div className="bg-[var(--card)] px-4 py-3">
                <dt className="eyebrow">Por precio</dt>
                <dd className={`display num mt-1 text-2xl ${tone(byPrice)}`}>{signed(byPrice)}</dd>
                <dd className="muted mt-1 text-xs">Cotizaciones, tasaciones y tipo de cambio sobre lo que ya había.</dd>
              </div>
              <div className="bg-[var(--card)] px-4 py-3">
                <dt className="eyebrow">Por cantidad</dt>
                <dd className={`display num mt-1 text-2xl ${tone(byQty)}`}>{signed(byQty)}</dd>
                <dd className="muted mt-1 text-xs">Depósitos, retiros, compras, ventas, intereses, cuotas pagadas de deudas e intereses de préstamos.</dd>
              </div>
            </dl>

            <table className="w-full text-sm lg:min-w-[860px]">
              <thead>
                <tr>
                  <th className="py-2">Activo</th>
                  <th className="hidden py-2 pl-3 text-right lg:table-cell">Anterior</th>
                  <th className="hidden py-2 pl-3 text-right lg:table-cell">Actual</th>
                  <th className="hidden py-2 pl-3 text-right lg:table-cell">Por precio</th>
                  <th className="hidden py-2 pl-3 text-right lg:table-cell">Por cantidad</th>
                  <th className="py-2 pl-3 text-right">Variación</th>
                  <th className="hidden py-2 pl-3 lg:table-cell" />
                </tr>
              </thead>
              <tbody>
                {moved.map((r) => (
                  <tr key={r.asset_id} className="border-t border-[var(--line)]">
                    <td className="py-2">
                      <div className="flex gap-3">
                        <AssetLogo symbol={r.symbol} category={r.category} account={r.account} meta={r.meta} size={30} />
                        <div className="min-w-0">
                          <Link href={`/a/${r.asset_id}`} className="font-medium text-[var(--heading)] hover:text-[var(--accent)]">{r.name}</Link>
                          <div className="muted text-xs">{assetLine(r, true)}</div>
                          <div className="muted text-xs tabular-nums lg:hidden">
                            {usd(r.v0)} → {usd(r.v1)}
                          </div>
                          <div className="muted text-xs tabular-nums lg:hidden">
                            precio {signed(r.byPrice)} · cantidad {signed(r.byQty)}
                          </div>
                          {note(r) && <div className="muted text-xs">{note(r)}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="num hidden py-2 pl-3 text-right lg:table-cell">{r.q0 === null ? '—' : usd(r.v0)}</td>
                    <td className="num hidden py-2 pl-3 text-right lg:table-cell">{r.q1 === null ? '—' : usd(r.v1)}</td>
                    <td className={`num hidden py-2 pl-3 text-right lg:table-cell ${tone(r.byPrice)}`}>{signed(r.byPrice)}</td>
                    <td className={`num hidden py-2 pl-3 text-right lg:table-cell ${tone(r.byQty)}`}>{signed(r.byQty)}</td>
                    <td className="py-2 pl-3 text-right">
                      <span className={`num block ${tone(r.change)}`}>{signed(r.change)}</span>
                      {r.v0 !== 0 && <span className={`num block text-xs ${tone(r.change)}`}>{pct(r.change / Math.abs(r.v0))}</span>}
                    </td>
                    <td className="hidden py-2 pl-3 lg:table-cell">
                      <Bar value={r.change} max={maxAbs} />
                    </td>
                  </tr>
                ))}
                {moved.length === 0 && (
                  <tr className="border-t border-[var(--line)]">
                    <td colSpan={7} className="muted py-4 text-center">
                      Ningún activo cambió de valor entre los dos cierres.
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="border-t border-[var(--heading)] font-medium text-[var(--heading)]">
                  <td className="py-2">
                    Total
                    <div className="muted text-xs font-normal tabular-nums lg:hidden">
                      precio {signed(byPrice)} · cantidad {signed(byQty)}
                    </div>
                  </td>
                  <td className="num hidden py-2 pl-3 text-right lg:table-cell">{usd(before)}</td>
                  <td className="num hidden py-2 pl-3 text-right lg:table-cell">{usd(after)}</td>
                  <td className={`num hidden py-2 pl-3 text-right lg:table-cell ${tone(byPrice)}`}>{signed(byPrice)}</td>
                  <td className={`num hidden py-2 pl-3 text-right lg:table-cell ${tone(byQty)}`}>{signed(byQty)}</td>
                  <td className={`num py-2 pl-3 text-right ${tone(total)}`}>{signed(total)}</td>
                  <td className="hidden lg:table-cell" />
                </tr>
              </tfoot>
            </table>
            {still.length > 0 && (
              <p className="muted mt-3 text-xs">
                Sin variación ({still.length}): {still.map((r) => (r.stale ? `${r.name} (precio repetido)` : r.name)).join(', ')}.
              </p>
            )}
            <p className="muted mt-3 max-w-3xl text-xs leading-relaxed">
              Metodología: por cantidad = (unidades de hoy − unidades del cierre anterior) × precio en USD del cierre anterior; por precio = el
              resto de la variación, con las unidades de hoy. Los activos en pesos incluyen en el efecto precio el cambio del dólar cripto o del
              MEP. Un activo nuevo cuenta todo como cantidad, y uno que dejó de estar, como cantidad negativa. Las deudas restan: si una deuda
              baja, la variación es positiva; las cuotas pagadas cuentan como cantidad y el cambio del dólar como precio. En los préstamos
              otorgados, el interés devengado cuenta como cantidad. Si una fuente no respondió, el activo repite el precio anterior y se
              marca como precio repetido: su movimiento aparece junto en el cierre siguiente.
            </p>
          </>
        )}
      </section>
    </div>
  )
}

const tone = (v: number) => (v >= 0.5 ? 'up' : v <= -0.5 ? 'down' : 'muted')
const signed = (v: number) => `${v >= 0.5 ? '+' : ''}${usd(v)}`
const note = (r: { q0: number | null; q1: number | null; stale: boolean }) =>
  r.q0 === null ? 'Nuevo desde este cierre' : r.q1 === null ? 'Ya no figura en este cierre' : r.stale ? 'Precio repetido: la fuente no respondió' : ''

/** Barra de aporte a la variación, a escala de la mayor variación de la tabla (como en el detalle de PnL). */
function Bar({ value, max }: { value: number; max: number }) {
  if (max === 0) return null
  const w = `${(Math.abs(value) / max) * 50}%`
  return (
    <span aria-hidden="true" className="relative ml-auto block h-1 w-20 bg-[var(--pale)]">
      <span className="absolute -top-0.5 -bottom-0.5 left-1/2 w-px bg-[var(--faint)]" />
      <span
        className="absolute inset-y-0"
        style={value >= 0 ? { left: '50%', width: w, background: 'var(--up)' } : { right: '50%', width: w, background: 'var(--down)' }}
      />
    </span>
  )
}
