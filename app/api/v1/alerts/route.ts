import { z } from 'zod'

import { addAlerts, alertSchema, deprecateAlerts, deprecateSchema, KINDS, listAlerts, testTelegram, type Kind } from '@/lib/alerts'
import { handler } from '@/lib/api'

export const dynamic = 'force-dynamic'

// GET ?kind=riesgo&days=30&status=active (kind: riesgo | insight | fundamental): lo ya avisado, para que la rutina revise y no repita.
// Las vigentes vienen siempre; las deprecadas, solo de los últimos `days` días.
export const GET = handler(null, async (_body, request) => {
  const url = new URL(request.url)
  const kind = url.searchParams.get('kind')
  const status = url.searchParams.get('status')
  const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 365)
  return {
    alerts: await listAlerts(
      KINDS.includes(kind as Kind) ? (kind as Kind) : null,
      days,
      status === 'active' || status === 'deprecated' ? status : null,
    ),
  }
})

// POST {"test":true} manda un mensaje de prueba a Telegram sin guardar nada.
// POST {"deprecate":[{"id":"<uuid>","reason":"..."}],"alerts":[{"kind":"riesgo","severity":"alta","asset":"<id o key>","title":"...","body":"...","action":"vender","sources":[{"url":"..."}],"dedupe_key":"..."}]}
// Primero depreca y después crea, así una alerta nueva puede reemplazar a una vieja en la misma corrida.
const postSchema = z.object({
  alerts: z.array(alertSchema).max(50).default([]),
  deprecate: z.array(deprecateSchema).max(100).default([]),
  test: z.boolean().optional(),
})
export const POST = handler(postSchema, async (body) => {
  if (body.test) return testTelegram()
  const deprecated = body.deprecate.length > 0 ? await deprecateAlerts(body.deprecate) : 0
  const added = body.alerts.length > 0 ? await addAlerts(body.alerts) : { created: 0, duplicates: 0, notified: 0 }
  return { deprecated, ...added }
})
