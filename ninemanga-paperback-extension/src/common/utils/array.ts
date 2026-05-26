export function uniqueBy<T>(items: T[], keySelector: (item: T) => string): T[] {
  const seen = new Set<string>()
  const result: T[] = []

  for (const item of items) {
    const key = keySelector(item)
    if (!key || seen.has(key)) continue

    seen.add(key)
    result.push(item)
  }

  return result
}

export function uniqueStrings(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))]
}
