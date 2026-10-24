import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'

import { googleClientId, googleEnabled } from '@/lib/auth'

export function GET(request: Request): NextResponse {
  if (!googleEnabled()) return NextResponse.redirect(new URL('/login?error=google', request.url))
  const state = randomBytes(16).toString('hex')
  const params = new URLSearchParams({
    client_id: googleClientId(),
    redirect_uri: new URL('/api/auth/callback/google', request.url).toString(),
    response_type: 'code',
    scope: 'openid email',
    state,
    prompt: 'select_account',
  })
  const response = NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
  response.cookies.set('oauth_state', state, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 600 })
  return response
}
