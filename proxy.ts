import { NextResponse, type NextRequest } from 'next/server'

import { readSession, SESSION_COOKIE } from '@/lib/auth'

// Todo el sitio requiere sesión, salvo el login y la API (que usa su propio token).
const PUBLIC_PREFIXES = ['/login', '/api/auth/', '/api/v1/', '/api/cron/']

export default function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next()

  if (readSession(request.cookies.get(SESSION_COOKIE)?.value) !== null) return NextResponse.next()

  const login = request.nextUrl.clone()
  login.pathname = '/login'
  login.search = ''
  return NextResponse.redirect(login)
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|logos/).*)'],
}
