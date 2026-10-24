import { ActionForm } from '@/components/ActionForm'
import { readOnlyToken } from '@/lib/auth'
import { q } from '@/lib/db'
import { ars, CATEGORY_LABELS, label as catLabel, pct, qty, usd } from '@/lib/format'
import { applyOwnerConfig, isEmpty } from '@/lib/owner-config'
import { lastSyncRuns } from '@/lib/queries'

import {
  addCuota,
  addManualAsset,
  addWalletAction,
  deactivateAccount,
  deleteCuota,
  runSyncAction,
  saveProperty,
  saveDebt,
} from './actions'

export const dynamic = 'force-dynamic'
export const maxDuration = 800

const PROVIDERS = { zerion: 'EVM (MetaMask, Ledger, DeFi)', btc: 'Bitcoin', near: 'NEAR', mvx: 'MultiversX' }

export default async function Onboarding() {
  // La primera vez, con la base vacía, se carga sola la configuración de db/owner-config.json.
  const loaded = (await isEmpty()) ? await applyOwnerConfig() : null
  // Deuda en cuotas atada a un inmueble (la primera que haya): sus cuotas pagas se cargan como flujo del inmueble.
  const [debt] = await q<{ key: string; name: string; meta: Record<string, unknown>; property_key: string | null; property_name: string | null }>(
    `SELECT d.key, d.name, d.meta, p.key AS property_key, p.name AS property_name
     FROM assets d LEFT JOIN assets p ON p.id::text = d.meta->>'linked_asset_id'
     WHERE d.price_source = 'debt' AND d.active AND d.meta ? 'total_installments' ORDER BY d.created_at LIMIT 1`,
  )
  const [accounts, assets, runs, cuotas, manual] = await Promise.all([
    q<{ key: string; name: string; provider: string; address: string | null; sync: string }>(
      `SELECT key, name, provider, address, sync FROM accounts WHERE active ORDER BY provider, name`,
    ),
    q<{ key: string; name: string; symbol: string; category: string; price_source: string; meta: Record<string, any> }>(
      `SELECT key, name, symbol, category, price_source, meta FROM assets
       WHERE active AND price_source IN ('manual', 'invested') ORDER BY created_at`,
    ),
    lastSyncRuns(),
    q<{ id: string; date: string; amount: number; fx_ars_usd: number | null; amount_usd: number; external_id: string | null }>(
      `SELECT f.id, f.date::text, f.amount::float8 AS amount, f.fx_ars_usd::float8 AS fx_ars_usd, f.amount_usd::float8 AS amount_usd, f.external_id
       FROM cash_flows f JOIN assets s ON s.id = f.asset_id
       WHERE s.key = $1 AND f.kind = 'cuota' ORDER BY f.date`,
      [debt?.property_key ?? ''],
    ),
    q<{ key: string; name: string; symbol: string; category: string; account: string; quantity: number; apr: number | null }>(
      `SELECT s.key, s.name, s.symbol, s.category, a.name AS account,
              COALESCE((SELECT SUM(delta) FROM quantity_deltas d WHERE d.asset_id = s.id), 0)::float8 AS quantity,
              (s.meta->>'apr_manual')::float8 AS apr
       FROM assets s JOIN accounts a ON a.id = s.account_id
       WHERE s.active AND a.sync = 'manual' AND s.price_source IN ('stable', 'coingecko')
       ORDER BY a.name, s.name`,
    ),
  ])
  const wallets = accounts.filter((a) => a.address)
  const TOTAL = Number(debt?.meta.total_installments ?? 0)

  return (
    <div className="space-y-6">
      <h1 className="text-3xl">Configuración</h1>
      <p className="muted text-sm">
        IOL e IBKR se sincronizan automáticamente. En esta sección se administran las wallets y los activos sin integración.
        Los cambios se reflejan en el próximo cierre (diario, 21:15) o al ejecutarlo manualmente.
      </p>
      {loaded && (
        <p className="card p-4 text-sm">
          Se cargó la configuración inicial: {loaded.wallets} wallets, {loaded.assets} activos y {loaded.flows} movimientos.
          Verifíquela y ejecute el cierre.
        </p>
      )}
      <p className="muted text-xs">
        Los valores iniciales provienen de <code>db/owner-config.json</code> y se aplicaron una única vez, con la base vacía.
        Las modificaciones realizadas aquí se guardan en la base.
      </p>

      <section className="card space-y-4 p-6">
        <h2 className="text-sm font-medium">1 · Wallets ({wallets.length})</h2>
        <ul className="space-y-1 text-sm">
          {wallets.map((w) => (
            <li key={w.key} className="flex items-center justify-between gap-2 border-t border-[var(--line)] pt-1">
              <span className="min-w-0">
                {w.name} <span className="muted text-xs">· {PROVIDERS[w.provider as keyof typeof PROVIDERS] ?? w.provider} ·{' '}
                  <span title={w.address ?? ''} className="font-mono">{short(w.address ?? '')}</span>
                </span>
              </span>
              <form action={deactivateAccount}><input type="hidden" name="key" value={w.key} /><button className="muted text-xs">Quitar</button></form>
            </li>
          ))}
        </ul>
        <ActionForm action={addWalletAction} className="flex flex-wrap gap-2" label="Agregar wallet" pendingLabel="Agregando…" doneLabel="Wallet agregada" resetOnDone>
          <select name="provider" defaultValue="zerion">
            {Object.entries(PROVIDERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input name="name" placeholder="Nombre" required />
          <input name="address" placeholder="Address" required className="w-full flex-1 sm:min-w-[320px]" />
        </ActionForm>
      </section>

      <section className="card space-y-4 p-6">
        <h2 className="text-sm font-medium">2 · Inmuebles y vehículos</h2>
        <p className="muted text-sm">Se valúan por la última tasación; en su defecto, por el valor de compra y, si no lo hay, por el capital invertido. Los aportes y cuotas figuran en la ficha del activo.</p>
        {assets.map((m) => (
          <ActionForm key={m.key} action={saveProperty} className="grid gap-2 border-t border-[var(--line)] pt-4 md:grid-cols-4">
            <input type="hidden" name="key" value={m.key} />
            <input type="hidden" name="symbol" value={m.symbol} />
            <input type="hidden" name="category" value={m.category} />
            <input type="hidden" name="priceSource" value={m.price_source} />
            <label className="md:col-span-4 text-sm font-medium">
              <input name="name" defaultValue={m.name} className="w-full" />
            </label>
            <PropertyFields meta={m.meta} manual={m.price_source === 'manual'} />
          </ActionForm>
        ))}
        <ActionForm action={saveProperty} className="grid gap-2 border-t border-[var(--line)] pt-4 md:grid-cols-4" label="Agregar" pendingLabel="Agregando…" doneLabel="Agregado" resetOnDone>
          <Field label="Nombre (nuevo inmueble o vehículo)" name="name" value="" />
          <label className="muted text-xs">Tipo
            <select name="category" defaultValue="real_estate" className="w-full">
              <option value="real_estate">Inmueble</option>
              <option value="vehiculo">Vehículo</option>
              <option value="otros">Otro</option>
            </select>
          </label>
          <label className="muted text-xs">Se valúa por
            <select name="priceSource" defaultValue="manual" className="w-full">
              <option value="manual">Tasación</option>
              <option value="invested">Lo invertido (por ejemplo, en pozo)</option>
            </select>
          </label>
          <div />
          <PropertyFields meta={{}} manual />
        </ActionForm>
      </section>

      <section className="card space-y-3 p-6">
        <h2 className="text-sm font-medium">3 · Inmueble en cuotas{debt?.property_name ? `: ${debt.property_name}` : ''}</h2>
        <p className="muted text-sm">
          Cada cuota pagada se registra aquí (o por API: POST /api/v1/cash-flows, kind cuota). Suma a lo invertido en el inmueble
          y resta una de las que faltan. Deuda estimada = cuotas que faltan × última cuota pagada, en pesos, al dólar cripto del día.
        </p>
        {debt?.property_key ? (
          <>
            <p className="text-sm">
              Pagas: <b>{cuotas.length}</b> de {TOTAL} · faltan <b>{Math.max(TOTAL - cuotas.length, 0)}</b> · invertido en cuotas{' '}
              <b>{usd(cuotas.reduce((t, c) => t + c.amount_usd, 0))}</b>
              {cuotas.length > 0 && <> · deuda estimada <b>{ars(Math.max(TOTAL - cuotas.length, 0) * cuotas[cuotas.length - 1]!.amount)}</b></>}
            </p>
            <div className="overflow-x-auto">
            <table className="w-full text-xs sm:text-sm [&_td]:py-1 [&_td]:pr-3 [&_th]:pr-3">
              <thead><tr><th className="hidden sm:table-cell">#</th><th>Fecha</th><th className="text-right">Monto</th><th className="hidden text-right sm:table-cell">Dólar</th><th className="text-right">USD</th><th /></tr></thead>
              <tbody>
                {cuotas.map((c, i) => (
                  <tr key={c.id} className="border-t border-[var(--line)]">
                    <td className="hidden sm:table-cell">{i + 1}</td><td className="num">{c.date}</td><td className="num text-right">{ars(c.amount)}</td>
                    <td className="num hidden text-right sm:table-cell">{c.fx_ars_usd?.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? '—'}</td><td className="num text-right">{usd(c.amount_usd)}</td>
                    <td>{c.external_id?.startsWith('config:') ? null : (
                      <form action={deleteCuota}><input type="hidden" name="id" value={c.id} /><button className="muted text-xs">Eliminar</button></form>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <ActionForm action={addCuota} className="grid gap-2 md:grid-cols-4" label="Registrar cuota" pendingLabel="Registrando…" doneLabel="Cuota registrada" resetOnDone>
              <input type="hidden" name="asset" value={debt.property_key} />
              <label className="muted text-xs">Fecha de pago<input type="date" name="date" required className="w-full" /></label>
              <Field label="Monto pagado (ARS, nominal + ajuste)" name="amount" value="" />
              <Field label="Dólar usado (opcional; si no, el cripto de ese día)" name="fx" value="" />
            </ActionForm>
          </>
        ) : (
          <p className="muted text-xs">No hay ningún plan de cuotas. Si tenés un inmueble en cuotas, cargalo en la sección 2 y crealo acá.</p>
        )}
        <details className="text-sm" open={!debt}>
          <summary className="muted cursor-pointer text-xs">Parámetros del plan</summary>
          <ActionForm action={saveDebt} className="mt-2 grid gap-2 md:grid-cols-3">
            {debt ? (
              <input type="hidden" name="key" value={debt.key} />
            ) : (
              <label className="muted text-xs">Inmueble
                <select name="property" className="w-full">
                  {assets.filter((a) => a.category === 'real_estate').map((a) => <option key={a.key} value={a.key}>{a.name}</option>)}
                </select>
              </label>
            )}
            <Field label="Cuotas totales del plan" name="totalInstallments" value={TOTAL || ''} />
            <Field label="Cuota de referencia sin pagos registrados (ARS)" name="referenceInstallmentArs" value={String(debt?.meta.reference_installment_ars ?? '')} />
          </ActionForm>
        </details>
      </section>

      <section className="card space-y-3 p-6">
        <h2 className="text-sm font-medium">4 · Otros activos sin API (exchanges, bancos, efectivo)</h2>
        <table className="w-full text-sm [&_td]:py-1.5 [&_td]:pr-3 [&_th]:pr-3">
          <thead><tr><th>Activo</th><th className="hidden sm:table-cell">Tipo</th><th className="text-right">Cantidad</th><th className="text-right">APR</th></tr></thead>
          <tbody>
            {manual.map((m) => (
              <tr key={m.key} className="border-t border-[var(--line)]">
                <td>{m.name}<div className="muted text-xs">{m.account} · {m.symbol}<span className="sm:hidden"> · {catLabel(m.category)}</span></div></td>
                <td className="hidden sm:table-cell">{catLabel(m.category)}</td>
                <td className="num text-right">{qty(m.quantity)}</td><td className="num text-right">{m.apr !== null ? pct(m.apr) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted text-xs">Las cantidades se modifican registrando un movimiento por API (POST /api/v1/deltas) o a través de un agente.</p>
        <ActionForm action={addManualAsset} className="grid gap-2 md:grid-cols-4" label="Agregar" pendingLabel="Agregando…" doneLabel="Activo agregado" resetOnDone>
          <Field label="Cuenta" name="account" value="" />
          <Field label="Símbolo" name="symbol" value="" />
          <Field label="Nombre" name="name" value="" />
          <label className="text-xs muted">Tipo
            <select name="category" defaultValue="stablecoin" className="w-full">
              {Object.entries(CATEGORY_LABELS).filter(([k]) => k !== 'deuda').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <Field label="Cantidad" name="quantity" value="" />
          <label className="text-xs muted">Precio
            <select name="priceSource" defaultValue="stable" className="w-full">
              <option value="coingecko">CoinGecko</option>
              <option value="stable">Stablecoin (1 USD)</option>
            </select>
          </label>
          <Field label="Id CoinGecko (bitcoin, ethereum…)" name="priceRef" value="" />
          <Field label="APR % (si rinde, ej. Nexo)" name="aprPct" value="" />
          <Field label="Costo de adquisición total (USD; vacío para stablecoins, 1 por unidad)" name="costUsd" value="" />
        </ActionForm>
      </section>

      <section className="card space-y-3 p-6">
        <h2 className="text-sm font-medium">5 · Cierre del día</h2>
        <ActionForm action={runSyncAction} label="Ejecutar el cierre ahora" pendingLabel="Ejecutando el cierre (1 a 3 minutos)…" doneLabel="Cierre completado" requireEdit={false}>
          <span />
        </ActionForm>
        <ul className="space-y-1 text-xs">
          {runs.map((r, i) => (
            <li key={i}><span className={r.status === 'error' ? 'down' : r.status === 'ok' ? 'up' : 'muted'}>{r.status}</span> · {r.started_at.slice(0, 16)} · {r.source}{r.detail ? ` · ${r.detail}` : ''}</li>
          ))}
        </ul>
      </section>

      <section className="card space-y-3 p-6">
        <h2 className="text-sm font-medium">6 · Token de solo lectura para agentes</h2>
        <p className="muted text-xs">
          Sirve para que otro agente lea el estado (<code>GET /api/v1/holdings</code>, <code>/alerts</code>, <code>/owner-config</code>) con{' '}
          <code>Authorization: Bearer &lt;token&gt;</code>. No puede cargar ni cambiar nada: cualquier POST o PATCH devuelve 401.
        </p>
        <details className="text-xs">
          <summary className="cursor-pointer text-[var(--accent)]">Mostrar token</summary>
          <code className="mt-2 block select-all break-all rounded-[5px] border border-[var(--line)] p-3">{readOnlyToken()}</code>
        </details>
      </section>
    </div>
  )
}

/** Address abreviada (0x1234…abcd); la completa queda en el tooltip. */
function short(address: string): string {
  return address.length > 20 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address
}

function Field({ label, name, value }: { label: string; name: string; value: string | number }) {
  return (
    <label className="muted text-xs">
      {label}
      <input name={name} defaultValue={String(value ?? '')} className="w-full" />
    </label>
  )
}

function PropertyFields({ meta: m, manual }: { meta: Record<string, any>; manual: boolean }) {
  return (
    <>
      <Field label="Invertido hasta hoy (USD)" name="investedUsd" value={m.invested_base_usd ?? ''} />
      <Field label="Costo de adquisición (USD)" name="purchaseUsd" value={m.purchase_value_usd ?? ''} />
      {manual && <Field label="Tasación hoy (USD, opcional)" name="valuationUsd" value="" />}
      {!manual && <div />}
      <div />
      <Field label="Egreso mensual (expensas)" name="expenseAmount" value={m.recurring_expense?.amount ?? 0} />
      <Currency name="expenseCurrency" value={m.recurring_expense?.currency ?? 'ARS'} />
      <Field label="Ingreso mensual (alquiler)" name="incomeAmount" value={m.recurring_income?.amount ?? 0} />
      <Currency name="incomeCurrency" value={m.recurring_income?.currency ?? 'ARS'} />
    </>
  )
}

function Currency({ name, value }: { name: string; value: string }) {
  return (
    <label className="muted text-xs">
      Moneda
      <select name={name} defaultValue={value} className="w-full">
        <option value="ARS">ARS</option>
        <option value="USD">USD</option>
      </select>
    </label>
  )
}
