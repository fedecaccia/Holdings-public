import { NextResponse } from 'next/server'
import { z } from 'zod'

import { canUseApi } from './auth'
import { OpError } from './ops'

/** Envoltorio de los endpoints /api/v1: token (el de solo lectura, solo en GET), JSON y errores legibles para un agente. */
export function handler<T>(schema: z.ZodType<T> | null, fn: (body: T, request: Request) => Promise<unknown>) {
  return async (request: Request): Promise<NextResponse> => {
    if (!canUseApi(request)) return NextResponse.json({ error: 'token inválido' }, { status: 401 })
    try {
      let body = undefined as T
      if (schema) {
        const raw = await request.json().catch(() => null)
        const parsed = schema.safeParse(raw)
        if (!parsed.success) return NextResponse.json({ error: 'body inválido', issues: parsed.error.issues }, { status: 400 })
        body = parsed.data
      }
      return NextResponse.json(await fn(body, request))
    } catch (error) {
      const status = error instanceof OpError ? 400 : 500
      return NextResponse.json({ error: (error as Error).message }, { status })
    }
  }
}
