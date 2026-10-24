import { NextResponse } from 'next/server'

import { allowedEmail, createSessionValue, SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth'
import { verifyPassword } from '@/lib/password'

export async function POST(request: Request): Promise<NextResponse> {
  const form = await request.formData()
  const password = String(form.get('password') ?? '')
  const ok = password.length > 0 && (await verifyPassword(password))
  const url = new URL(ok ? '/' : '/login?error=1', request.url)
  const response = NextResponse.redirect(url, 303)
  if (ok) response.cookies.set(SESSION_COOKIE, createSessionValue(allowedEmail()), sessionCookieOptions)
  return response
}
