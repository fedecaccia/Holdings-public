import { NextResponse } from 'next/server'

import { addAlerts, deprecateCloseAlerts } from '@/lib/alerts'
import { isCronRequest } from '@/lib/auth'
import { q } from '@/lib/db'
import { todayAR } from '@/lib/dates'
import { runDailySync } from '@/lib/sync'

export const maxDuration = 800
export const dynamic = 'force-dynamic'

// El cierre corre a las 21:15 de Argentina (00:15 UTC): justo después de que Zerion renueva su cuota diaria y de la
// última carga manual del día. A las 23:30 (?retry=1) se repite solo si faltó o quedó alguna fuente con error.
// Lo que sigue fallando avisa por Telegram (alerta de riesgo): un cierre roto nunca queda en silencio.
export async function GET(request: Request): Promise<NextResponse> {
  const retry = new URL(request.url).searchParams.has('retry')
  // Siempre deja rastro en los logs, también si se rechaza o se saltea: así se ve si el cron de Vercel llegó.
  if (!isCronRequest(request)) {
    console.error(`[cron] daily${retry ? ' retry' : ''} rechazado: ${request.headers.get('authorization') ? 'token distinto' : 'sin token'}`)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const date = todayAR()
  console.log(`[cron] daily${retry ? ' retry' : ''} ${date}`)

  let unfinished = false
  if (retry) {
    const pending = await failedSources(date)
    if (pending !== null && pending.length === 0) {
      console.log(`[cron] reintento salteado: el cierre del ${date} salió completo`)
      return NextResponse.json({ date, skipped: 'el cierre de hoy salió completo' })
    }
    unfinished = pending === null || pending.includes('cierre')
  }

  // Marca de inicio: si Vercel corta la función antes de terminar, el reintento ve 'started' sin su 'ok' y avisa.
  await q(`INSERT INTO sync_runs (date, source, status) VALUES ($1, 'cierre', 'started')`, [date])
  try {
    const result = await runDailySync()
    await q(`INSERT INTO sync_runs (date, source, status) VALUES ($1, 'cierre', 'ok')`, [date])
    const failed = result.logs.filter((l) => l.status === 'error')
    const keys: string[] = []
    if (unfinished) {
      keys.push(await alert(date, retry, 'El cierre de las 21:15 no corrió o no terminó', 'El reintento de las 23:30 lo volvió a correr.'))
    }
    if (failed.length > 0) {
      keys.push(await alert(date, retry, `${failed.length} fuentes con error en el cierre`, failed.map((l) => `${l.source}: ${l.detail ?? ''}`).join('\n')))
    }
    // En /riesgos queda vigente solo el aviso del último cierre: uno completo los resuelve, uno con errores los reemplaza.
    // Se depreca después de crear, así un fallo al crear deja vigente el aviso anterior.
    const reason = keys.length > 0 ? 'Lo reemplaza el aviso de un cierre posterior.' : `El cierre del ${date} salió completo.`
    await deprecateCloseAlerts(reason, keys).catch((e) => console.error('[cron] deprecar avisos de cierre', e))
    return NextResponse.json(result)
  } catch (error) {
    const key = await alert(date, retry, 'El cierre del día no se pudo completar', (error as Error).message.slice(0, 2000), 'critica').catch(() => null)
    if (key) await deprecateCloseAlerts('Lo reemplaza el aviso de un cierre posterior.', [key]).catch(() => {})
    throw error
  }
}

/** Fuentes cuya última corrida de hoy terminó en error ('cierre' si el cierre empezó y no terminó); null si hoy no hubo cierre. */
async function failedSources(date: string): Promise<string[] | null> {
  const rows = await q<{ source: string; status: string }>(
    `SELECT DISTINCT ON (source) source, status FROM sync_runs WHERE date = $1 ORDER BY source, started_at DESC`,
    [date],
  )
  if (rows.length === 0) return null
  return rows.filter((r) => r.status === 'error' || r.status === 'started').map((r) => r.source)
}

// El primer intento avisa con criticidad media (queda en la página, sin Telegram) porque a las 23:30 se reintenta;
// el reintento que sigue fallando avisa por Telegram.
async function alert(date: string, retry: boolean, title: string, body: string, severity?: 'critica'): Promise<string> {
  const dedupe_key = `cierre:${date}:${retry ? 'reintento' : 'cierre'}:${title}`
  await addAlerts([
    {
      kind: 'riesgo',
      severity: severity ?? (retry ? 'alta' : 'media'),
      title: `${title} (${date}${retry ? ', reintento' : ''})`,
      body: `${body}\n\nLos activos de esas fuentes quedan con el último precio (stale) hasta el próximo cierre que salga bien.`,
      sources: [],
      dedupe_key,
    },
  ])
  return dedupe_key
}
