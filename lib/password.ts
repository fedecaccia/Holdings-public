import argon2 from 'argon2'

/** AUTH_PASSWORD_HASH es un hash Argon2id, guardado en base64 (el formato nativo tiene `$` que rompen los .env). */
export async function verifyPassword(password: string): Promise<boolean> {
  const stored = (process.env.AUTH_PASSWORD_HASH ?? '').trim()
  if (!stored) return false
  const decoded = stored.startsWith('$argon2') ? stored : Buffer.from(stored, 'base64').toString('utf8')
  try {
    return await argon2.verify(decoded, password)
  } catch {
    return false
  }
}
