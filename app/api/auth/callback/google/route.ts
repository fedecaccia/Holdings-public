import { NextResponse, type NextRequest } from 'next/server'

import { allowedEmail, createSessionValue, googleClientId, googleClientSecret, googleEnabled, SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const fail = NextResponse.redirect(new URL('/login?error=google', request.url))
  const code = request.nextUrl.searchParams.get('code')
  const state = request.nextUrl.searchParams.get('state')
  if (!googleEnabled() || !code || !state || state !== request.cookies.get('oauth_state')?.value) return fail

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: googleClientId(),
      client_secret: googleClientSecret(),
      redirect_uri: new URL('/api/auth/callback/google', request.url).toString(),
      grant_type: 'authorization_code',
    }),
  })
  if (!tokenResponse.ok) return fail
  const { access_token } = (await tokenResponse.json()) as { access_token?: string }
  if (!access_token) return fail

  const userResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${access_token}` },
  })
  if (!userResponse.ok) return fail
  const user = (await userResponse.json()) as { email?: string; email_verified?: boolean }
  if (!user.email || !user.email_verified || user.email.toLowerCase() !== allowedEmail()) return fail

  const response = NextResponse.redirect(new URL('/', request.url))
  response.cookies.set(SESSION_COOKIE, createSessionValue(user.email), sessionCookieOptions)
  response.cookies.delete('oauth_state')
  return response
}
