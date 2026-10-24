import { createHmac, timingSafeEqual } from 'node:crypto'

// Un solo usuario. La sesión es una cookie firmada con HMAC: no se consulta
// la base en cada request, así no se gasta la cuota de Neon.
export const SESSION_COOKIE = 'holdings_session'
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30

function secret(): string {
  const s = process.env.SESSION_SECRET
  if (!s) throw new Error('Falta SESSION_SECRET')
  return s
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url')
}

export function createSessionValue(email: string): string {
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + MAX_AGE_SECONDS * 1000 })).toString('base64url')
  return `${payload}.${sign(payload)}`
}

export function readSession(value: string | undefined): { email: string } | null {
  if (!value) return null
  const [payload, signature] = value.split('.')
  if (!payload || !signature) return null
  const expected = Buffer.from(sign(payload))
  const given = Buffer.from(signature)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email: string; exp: number }
    return data.exp > Date.now() ? { email: data.email } : null
  } catch {
    return null
  }
}

export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: MAX_AGE_SECONDS,
}

export function allowedEmail(): string {
  return (process.env.ALLOWED_EMAIL ?? '').trim().toLowerCase()
}

function bearer(request: Request): string {
  const header = request.headers.get('authorization') ?? ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

function matches(token: string, valid: (string | undefined)[]): boolean {
  if (!token) return false
  return valid
    .filter((t): t is string => typeof t === 'string' && t.length >= 16)
    .some((t) => t.length === token.length && timingSafeEqual(Buffer.from(t), Buffer.from(token)))
}

/** Token para agentes y scripts: `Authorization: Bearer <AGENT_API_TOKEN>`. Lee y escribe. */
export function isAgentRequest(request: Request): boolean {
  return matches(bearer(request), [process.env.AGENT_API_TOKEN])
}

// Token de solo lectura para otros agentes: se deriva de SESSION_SECRET, así no hace falta otra variable
// ni otra tabla. Se ve en Configuración. Para revocarlo se cambia la versión (o SESSION_SECRET, que además
// cierra la sesión).
export function readOnlyToken(): string {
  // Clave propia (no la de la cookie), así el token nunca puede pasar por una firma de sesión.
  return `ro_${createHmac('sha256', `${secret()}|read-only-token`).update('v1').digest('base64url')}`
}

/** Acceso a /api/v1: el token de agente puede todo; el de solo lectura, solo GET. */
export function canUseApi(request: Request): boolean {
  if (isAgentRequest(request)) return true
  return request.method === 'GET' && Boolean(process.env.SESSION_SECRET) && matches(bearer(request), [readOnlyToken()])
}

export function isCronRequest(request: Request): boolean {
  const cron = process.env.CRON_SECRET
  return (cron !== undefined && request.headers.get('authorization') === `Bearer ${cron}`) || isAgentRequest(request)
}

export function googleEnabled(): boolean {
  return Boolean(googleClientId() && googleClientSecret())
}

// Acepta también los nombres de Auth.js (AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET).
export const googleClientId = (): string => process.env.GOOGLE_CLIENT_ID ?? process.env.AUTH_GOOGLE_ID ?? ''
export const googleClientSecret = (): string => process.env.GOOGLE_CLIENT_SECRET ?? process.env.AUTH_GOOGLE_SECRET ?? ''
