'use client'

import { useRef, useState, type ReactNode } from 'react'
import { useFormStatus } from 'react-dom'

// Form de server action con feedback: el botón se habilita solo si hubo cambios,
// muestra una ruedita mientras guarda y confirma (o muestra el error) al terminar.
export function ActionForm({
  action,
  children,
  className,
  label = 'Guardar',
  pendingLabel = 'Guardando…',
  doneLabel = 'Guardado',
  requireEdit = true,
  resetOnDone = false,
}: {
  /** Devuelve un texto para mostrar un error esperado (los errores de server actions no llegan al cliente en producción). */
  action: (form: FormData) => Promise<void | string>
  children: ReactNode
  className?: string
  label?: string
  pendingLabel?: string
  doneLabel?: string
  requireEdit?: boolean
  resetOnDone?: boolean
}) {
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const ref = useRef<HTMLFormElement>(null)

  return (
    <form
      className={className}
      onInput={() => {
        setDirty(true)
        setStatus(null)
      }}
      action={async (form) => {
        try {
          const error = await action(form)
          if (typeof error === 'string') {
            setStatus({ ok: false, text: error })
            return
          }
          if (resetOnDone) ref.current?.reset()
          setDirty(false)
          setStatus({ ok: true, text: doneLabel })
        } catch (e) {
          setStatus({ ok: false, text: e instanceof Error ? e.message : 'No se pudo guardar' })
        }
      }}
      ref={ref}
    >
      {children}
      <div className="flex items-center justify-end gap-3 self-end">
        {status && <span className={`text-xs ${status.ok ? 'up' : 'down'}`}>{status.ok ? `✓ ${status.text}` : status.text}</span>}
        <Submit disabled={requireEdit && !dirty} label={label} pendingLabel={pendingLabel} />
      </div>
    </form>
  )
}

function Submit({ disabled, label, pendingLabel }: { disabled: boolean; label: string; pendingLabel: string }) {
  const { pending } = useFormStatus()
  return (
    <button className="btn" disabled={disabled || pending}>
      {pending ? (
        <>
          <span className="spinner" />
          {pendingLabel}
        </>
      ) : (
        label
      )}
    </button>
  )
}
