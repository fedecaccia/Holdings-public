'use client'

import { useFormStatus } from 'react-dom'

import { runSyncAction } from '@/app/onboarding/actions'
import { Icon } from '@/components/Icon'

// Corre el cierre de hoy (fuentes, precios y snapshots). Mientras corre queda deshabilitado; al terminar,
// revalidatePath('/') vuelve a dibujar el dashboard con los números nuevos.
export function RefreshButton() {
  return (
    <form action={runSyncAction}>
      <Submit />
    </form>
  )
}

function Submit() {
  const { pending } = useFormStatus()
  return (
    <button
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 hover:text-[var(--accent)] disabled:cursor-wait"
      disabled={pending}
      title="Refrescar saldos y precios"
      aria-label="Refrescar saldos y precios"
    >
      <Icon name="refresh" size={13} className={pending ? 'animate-spin' : ''} />
      {pending && <span>Refrescando…</span>}
    </button>
  )
}
