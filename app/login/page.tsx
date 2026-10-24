import { googleEnabled } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams
  return (
    <div className="mx-auto mt-12 max-w-sm sm:mt-20">
      <p className="eyebrow">Acceso privado</p>
      <h1 className="mt-2 mb-6 text-3xl">Ingresar a holdings</h1>
      <div className="card space-y-4 p-6">
        {error && <p className="down text-sm">{error === 'google' ? 'La cuenta de Google no está habilitada.' : 'Contraseña incorrecta.'}</p>}
        <form action="/api/auth/login" method="post" className="space-y-3">
          <label className="muted block text-xs">
            Contraseña
            <input type="password" name="password" autoFocus required className="mt-1 w-full text-base" />
          </label>
          <button type="submit" className="btn w-full">Ingresar</button>
        </form>
        {googleEnabled() && (
          <a href="/api/auth/google" className="block rounded-[5px] border border-[var(--line)] py-2 text-center text-sm hover:border-[var(--accent)] hover:text-[var(--accent)]">
            Ingresar con Google
          </a>
        )}
      </div>
      <p className="mt-4 text-center text-[11px] text-[var(--faint)]">Patrimonio consolidado en USD, actualizado una vez por día.</p>
    </div>
  )
}
