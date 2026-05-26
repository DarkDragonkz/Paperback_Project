export function normalizeUrl(rawUrl: string | undefined, baseUrl: string): string {
  if (!rawUrl) return ''
  return new URL(rawUrl, baseUrl).toString()
}

export function pathIdFromUrl(rawUrl: string, baseUrl: string): string {
  const url = new URL(rawUrl, baseUrl)
  return `${url.pathname}${url.search}`.replace(/\?waring=1$/, '')
}

export function withQueryParam(rawUrl: string, baseUrl: string, key: string, value: string): string {
  const url = new URL(rawUrl, baseUrl)
  url.searchParams.set(key, value)
  return url.toString()
}
