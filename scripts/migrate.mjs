// Corre en cada build de Vercel: crea la base `holdings` dentro de la instancia
// de Neon si todavía no existe, y aplica db/schema.sql (idempotente).
// Sin credenciales (por ejemplo en un preview) no hace nada y el build sigue.
import { readFileSync } from 'node:fs'
import pg from 'pg'

const DB_NAME = process.env.HOLDINGS_DB_NAME || 'holdings'

function baseUrl() {
  return (
    process.env.HOLDINGS_DATABASE_URL_UNPOOLED ||
    process.env.HOLDINGS_POSTGRES_URL_NON_POOLING ||
    process.env.HOLDINGS_DATABASE_URL ||
    process.env.HOLDINGS_POSTGRES_URL
  )
}

function withDatabase(url, name) {
  const u = new URL(url)
  u.pathname = `/${name}`
  return u.toString()
}

async function main() {
  const url = baseUrl()
  if (!url) {
    console.log('[migrate] sin HOLDINGS_DATABASE_URL: no se migra nada')
    return
  }

  const admin = new pg.Client({ connectionString: url })
  await admin.connect()
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME])
  if (rows.length === 0) {
    await admin.query(`CREATE DATABASE "${DB_NAME}"`)
    console.log(`[migrate] base ${DB_NAME} creada`)
  }
  await admin.end()

  const client = new pg.Client({ connectionString: withDatabase(url, DB_NAME) })
  await client.connect()
  await client.query(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'))
  await audit(client)
  await client.end()
  console.log(`[migrate] esquema aplicado en ${DB_NAME}`)
}

// Auditoría en el log del build: avisa si en el último cierre hay dos tenencias de la misma cuenta con el
// mismo valor (±1 %, más de USD 100), que suele ser una posición contada dos veces.
async function audit(client) {
  const { rows } = await client.query(
    `WITH last AS (
       SELECT ds.asset_id, s.account_id, s.name, ds.value_usd FROM daily_snapshots ds JOIN assets s ON s.id = ds.asset_id
       WHERE ds.date = (SELECT MAX(date) FROM daily_snapshots) AND ds.value_usd > 100)
     SELECT a.name AS first, b.name AS second, round(a.value_usd)::int AS usd
     FROM last a JOIN last b ON a.account_id = b.account_id AND a.asset_id < b.asset_id
       AND abs(a.value_usd - b.value_usd) <= 0.01 * a.value_usd`,
  )
  // Solo el conteo: los nombres y montos no van al log del build.
  console.log(`[audit] posibles duplicados en el último cierre: ${rows.length}`)
}

main().catch((error) => {
  console.error('[migrate] falló:', error.message)
  process.exit(1)
})
