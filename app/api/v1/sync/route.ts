import { z } from 'zod'

import { handler } from '@/lib/api'
import { isIsoDate } from '@/lib/dates'
import { runDailySync } from '@/lib/sync'

export const maxDuration = 800

// POST {} corre el cierre de hoy. {"fetch_sources": false} solo recalcula snapshots con lo que hay en la base.
// {"skip_zerion": true} lee las wallets EVM directo por Alchemy (para probar el respaldo).
export const POST = handler(
  z.object({ date: z.string().refine(isIsoDate).optional(), fetch_sources: z.boolean().optional(), skip_zerion: z.boolean().optional() }),
  (body) => runDailySync({ date: body.date, fetchSources: body.fetch_sources, skipZerion: body.skip_zerion }),
)
