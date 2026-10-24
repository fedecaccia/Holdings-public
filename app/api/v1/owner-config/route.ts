import { NextResponse } from 'next/server'

import { canUseApi } from '@/lib/auth'
import { exportOwnerConfig } from '@/lib/owner-config'

export const dynamic = 'force-dynamic'

// Backup en el formato de db/owner-config.json con el estado de hoy, para reconstruir una base nueva.
// Con datos reales, guardarlo fuera de un repo público.
export async function GET(request: Request): Promise<Response> {
  if (!canUseApi(request)) return NextResponse.json({ error: 'token inválido' }, { status: 401 })
  const body = `${JSON.stringify(await exportOwnerConfig(), null, 2)}\n`
  return new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}
