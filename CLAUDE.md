# CLAUDE.md

Holdings: a personal net worth dashboard. See README.md for how it works and the API.

Rules:
- Keep it simple. Before adding a table, an endpoint or a dependency, ask whether it is needed today.
- Never run anything against the production database from a test.
- Go easy on the Neon quota: HTTP driver (`lib/db.ts`), batch writes (`jsonb_to_recordset`), one daily close (plus a retry that only runs if the close failed), no preview branches, no database queries in the proxy.
- If a source fails, never write zero: repeat the last price with `stale = true`.
- Amounts carry their currency. Peso amounts are converted at the day's "dólar cripto" (`fx_rates`), except securities quoted in pesos (CEDEARs, corporate bonds, IOL stocks), which use the day's MEP rate.
- The schema lives in `db/schema.sql` and must stay idempotent (`IF NOT EXISTS`).
- Each integration's pitfalls (IOL, IBKR, Zerion) are commented in `lib/sources/*`.
