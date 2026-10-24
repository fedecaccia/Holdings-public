import { z } from 'zod'

import { handler } from '@/lib/api'
import { addDeltas, deltaSchema } from '@/lib/ops'

// POST {"deltas":[{"asset":"<id o key>","delta":"-5","date":"2026-10-21","note":"venta","external_id":"..."}]}
export const POST = handler(z.object({ deltas: z.array(deltaSchema).min(1).max(100) }), async (body) => ({
  results: await addDeltas(body.deltas),
}))
