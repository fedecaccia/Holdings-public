import { z } from 'zod'

import { q } from './db'

// Alertas de las rutinas diarias de riesgos e insights y de la mensual de fundamentales (agentes programados, fuera de esta app).
// Una alerta `fundamental` es la valuación del mes de una empresa (valor justo y zona de compra); la rutina de insights las lee para avisar cuando un precio entra en zona.
// La de clave `fundamental:research:<año-mes>` es el resumen mensual de los reportes públicos de bancos y gestoras grandes.
// La rutina investiga y decide; la app guarda en lote y avisa por Telegram solo lo nuevo de criticidad alta o crítica.

export const KINDS = ['riesgo', 'insight', 'fundamental'] as const
export const SEVERITIES = ['baja', 'media', 'alta', 'critica'] as const
export type Kind = (typeof KINDS)[number]
export type Severity = (typeof SEVERITIES)[number]

const NOTIFY: Severity[] = ['alta', 'critica']

export const alertSchema = z.object({
  kind: z.enum(KINDS),
  severity: z.enum(SEVERITIES),
  asset: z.string().min(1).optional(), // id o key de GET /api/v1/holdings
  symbol: z.string().max(40).optional(),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
  action: z.string().max(40).optional(),
  sources: z.array(z.object({ title: z.string().max(300).optional(), url: z.string().url() })).max(10).default([]),
  dedupe_key: z.string().min(1).max(200),
})

export type AlertRow = {
  id: string
  kind: Kind
  severity: Severity
  asset_id: string | null
  asset_name: string | null
  symbol: string | null
  title: string
  body: string
  action: string | null
  sources: { title?: string; url: string }[]
  dedupe_key: string
  notified_at: string | null
  created_at: string
  deprecated_at: string | null
  deprecated_reason: string | null
}

export const deprecateSchema = z.object({ id: z.string().uuid(), reason: z.string().min(1).max(300) })

/** Inserta en una sola consulta; las repetidas (misma dedupe_key) se ignoran salvo que estén deprecadas. Devuelve solo las nuevas. */
export async function addAlerts(input: z.infer<typeof alertSchema>[]) {
  const rows = await q<AlertRow & { asset_ref: string | null }>(
    `WITH x AS (
       -- Una clave repetida dentro del lote haría fallar el ON CONFLICT DO UPDATE: queda la primera.
       SELECT DISTINCT ON (dedupe_key) * FROM jsonb_to_recordset($1::jsonb)
         AS x(kind text, severity text, asset text, symbol text, title text, body text, action text, sources jsonb, dedupe_key text)
     ), ins AS (
       INSERT INTO alerts (kind, severity, asset_id, symbol, title, body, action, sources, dedupe_key)
       SELECT x.kind, x.severity, a.id, COALESCE(x.symbol, a.symbol), x.title, x.body, x.action, COALESCE(x.sources, '[]'), x.dedupe_key
       FROM x LEFT JOIN assets a ON a.key = x.asset OR a.id::text = x.asset
       -- Repetida: se ignora, salvo que la existente esté deprecada; ahí vuelve a estar vigente con el texto nuevo.
       ON CONFLICT (dedupe_key) DO UPDATE SET
         severity = EXCLUDED.severity, asset_id = EXCLUDED.asset_id, symbol = EXCLUDED.symbol, title = EXCLUDED.title,
         body = EXCLUDED.body, action = EXCLUDED.action, sources = EXCLUDED.sources, notified_at = NULL,
         deprecated_at = NULL, deprecated_reason = NULL, created_at = now()
       WHERE alerts.deprecated_at IS NOT NULL
       RETURNING *
     )
     SELECT ins.*, a.name AS asset_name FROM ins LEFT JOIN assets a ON a.id = ins.asset_id`,
    [JSON.stringify(input)],
  )
  const tg = await notifyPending()
  return { created: rows.length, duplicates: input.length - rows.length, ...tg }
}

/** Avisa por Telegram, en un solo mensaje, las alertas alta o crítica de los últimos 3 días que todavía no salieron:
 * las recién creadas y las que fallaron antes (así un 429 o una caída de Telegram no pierde un riesgo crítico). */
async function notifyPending() {
  if (!telegramReady()) return { notified: 0, telegram: 'sin TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID' }
  const pending = await q<AlertRow>(
    `SELECT al.*, a.name AS asset_name FROM alerts al LEFT JOIN assets a ON a.id = al.asset_id
     WHERE al.notified_at IS NULL AND al.deprecated_at IS NULL AND al.severity = ANY($1::text[]) AND al.created_at > now() - interval '3 days'
     ORDER BY CASE al.severity WHEN 'critica' THEN 0 ELSE 1 END, al.created_at`,
    [NOTIFY],
  )
  if (pending.length === 0) return { notified: 0, telegram: 'ok' }
  const sent = await notify(pending)
  if (sent.length > 0) await q(`UPDATE alerts SET notified_at = now() WHERE id = ANY($1::uuid[])`, [sent])
  return { notified: sent.length, telegram: sent.length === pending.length ? 'ok' : `fallaron ${pending.length - sent.length} (se reintentan en el próximo POST)` }
}

/** Depreca los avisos de cierre vigentes salvo los de esta corrida (`keep`): los resolvió un cierre completo o los reemplaza el último. */
export async function deprecateCloseAlerts(reason: string, keep: string[] = []) {
  await q(
    `UPDATE alerts SET deprecated_at = now(), deprecated_reason = $1
     WHERE dedupe_key LIKE 'cierre:%' AND deprecated_at IS NULL AND dedupe_key <> ALL($2::text[])`,
    [reason, keep],
  )
}

/** Marca como deprecadas las que ya no valen (una sola consulta). Las ya deprecadas no se tocan. */
export async function deprecateAlerts(input: z.infer<typeof deprecateSchema>[]) {
  const rows = await q<{ id: string }>(
    `UPDATE alerts al SET deprecated_at = now(), deprecated_reason = x.reason
     FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, reason text)
     WHERE al.id = x.id AND al.deprecated_at IS NULL
     RETURNING al.id`,
    [JSON.stringify(input)],
  )
  return rows.length
}

/** Para la página y para que la rutina revise lo que dijo: las vigentes siempre (sin importar la fecha),
 * las deprecadas solo de los últimos `days` días. `status` filtra unas u otras. */
export async function listAlerts(kind: Kind | null, days = 90, status: 'active' | 'deprecated' | null = null): Promise<AlertRow[]> {
  return q<AlertRow>(
    `SELECT al.*, a.name AS asset_name FROM alerts al LEFT JOIN assets a ON a.id = al.asset_id
     WHERE ($1::text IS NULL OR al.kind = $1)
       AND (al.deprecated_at IS NULL OR al.created_at > now() - make_interval(days => $2::int))
       AND ($3::text IS NULL OR ($3::text = 'active') = (al.deprecated_at IS NULL))
     ORDER BY al.created_at DESC LIMIT 500`,
    [kind, days, status],
  )
}

// ── Telegram ────────────────────────────────────────────────────────
const telegramReady = () => Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const SEVERITY_LABEL: Record<Severity, string> = { baja: 'Baja', media: 'Media', alta: 'Alta', critica: 'Crítica' }
const KIND_LABEL: Record<Kind, string> = { riesgo: 'Riesgo', insight: 'Insight', fundamental: 'Valuación' }
const KIND_PAGE: Record<Kind, string> = { riesgo: 'riesgos', insight: 'insights', fundamental: 'fundamentales' }
export const isResearch = (a: Pick<AlertRow, 'dedupe_key'>) => a.dedupe_key.startsWith('fundamental:research:')
const DOT: Record<Severity, string> = { baja: '⚪', media: '🟡', alta: '🟠', critica: '🔴' }

function message(a: AlertRow): string {
  const what = KIND_LABEL[a.kind]
  const page = KIND_PAGE[a.kind]
  const lines = [
    // El resumen de research va siempre alta solo para que salga: la criticidad no dice nada.
    isResearch(a)
      ? '📚 <b>Research del mes</b>'
      : `${DOT[a.severity]} <b>${what} ${SEVERITY_LABEL[a.severity].toLowerCase()}</b>${a.symbol ? ` · ${esc(a.symbol)}` : ''}`,
    `<b>${esc(a.title)}</b>`,
    // El resumen de research es de una página; el resto, de una o dos oraciones. Con 2800 sigue entrando en un mensaje.
    esc(a.body.length > 2800 ? `${a.body.slice(0, 2800)}…` : a.body),
  ]
  if (a.action) lines.push(`Acción sugerida: <b>${esc(a.action)}</b>`)
  const src = a.sources.slice(0, 3).map((s) => `<a href="${esc(s.url)}">${esc(s.title || new URL(s.url).hostname)}</a>`)
  if (src.length) lines.push(`Fuentes: ${src.join(' · ')}`)
  const base = process.env.APP_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '')
  if (base) lines.push(`${base.replace(/\/$/, '')}/${page}`)
  return lines.join('\n\n')
}

const LIMIT = 4000 // Telegram corta en 4096 caracteres

async function send(text: string): Promise<boolean> {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  }).catch(() => null)
  if (!res?.ok) console.error('[alerts] telegram', res?.status, await res?.text().catch(() => ''))
  return Boolean(res?.ok)
}

/** Mensaje de prueba, sin guardar nada: confirma que el bot y el chat están bien configurados. */
export async function testTelegram() {
  if (!telegramReady()) return { ok: false, error: 'falta TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID en Vercel' }
  const ok = await send('✅ Holdings conectado. Acá vas a recibir los riesgos, insights y valuaciones de criticidad alta o crítica.')
  return ok ? { ok: true } : { ok: false, error: 'Telegram rechazó el mensaje (ver logs de Vercel, [alerts])' }
}

/** Junta las alertas en la menor cantidad de mensajes (uno, salvo que pase el límite) y devuelve los ids que salieron. */
async function notify(alerts: AlertRow[]): Promise<string[]> {
  const sep = '\n\n— — —\n\n'
  const batches: AlertRow[][] = []
  let current: AlertRow[] = []
  let size = 0
  for (const a of alerts) {
    const len = message(a).length + sep.length
    if (current.length > 0 && size + len > LIMIT) {
      batches.push(current)
      current = []
      size = 0
    }
    current.push(a)
    size += len
  }
  if (current.length > 0) batches.push(current)
  const sent: string[] = []
  for (const b of batches) if (await send(b.map(message).join(sep))) sent.push(...b.map((a) => a.id))
  return sent
}
