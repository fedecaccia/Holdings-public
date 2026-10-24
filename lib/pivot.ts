/** De filas (date, category, value) a filas por fecha con una columna por categoría. */
export function pivot(rows: { date: string; category: string; value: number }[], exclude: string[] = []) {
  const byDate = new Map<string, Record<string, number | string>>()
  const keys = new Set<string>()
  for (const r of rows) {
    if (exclude.includes(r.category)) continue
    keys.add(r.category)
    const row = byDate.get(r.date) ?? { date: r.date }
    row[r.category] = r.value
    byDate.set(r.date, row)
  }
  return { data: [...byDate.values()] as ({ date: string } & Record<string, number | string>)[], keys: [...keys] }
}
