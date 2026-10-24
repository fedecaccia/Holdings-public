import { neon, type NeonQueryFunction } from '@neondatabase/serverless'

// Driver HTTP de Neon: sin pool ni conexiones abiertas, así el compute se
// duerme apenas termina la consulta. La base es `holdings` (o HOLDINGS_DB_NAME),
// dentro de la instancia de Neon que Vercel conecta con el prefijo HOLDINGS_.
let client: NeonQueryFunction<false, false> | null = null

function connectionString(): string {
  const raw =
    process.env.HOLDINGS_DATABASE_URL ||
    process.env.HOLDINGS_POSTGRES_URL ||
    process.env.HOLDINGS_DATABASE_URL_UNPOOLED
  if (!raw) throw new Error('Falta HOLDINGS_DATABASE_URL')
  const url = new URL(raw)
  url.pathname = `/${process.env.HOLDINGS_DB_NAME || 'holdings'}`
  return url.toString()
}

export function db(): NeonQueryFunction<false, false> {
  if (client === null) client = neon(connectionString())
  return client
}

/** Consulta parametrizada: `q('SELECT * FROM assets WHERE id = $1', [id])`. */
export async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db().query(text, params)) as T[]
}
