const IMAGE_PROXY_BASE_URL = 'https://images.weserv.nl/'
const IMAGE_PROXY_OPTIONS = 'output=webp&q=80'
const IMAGE_PROXY_HOST_PATTERN = /^https?:\/\/(?:images\.weserv\.nl|wsrv\.nl)\//i

export function proxiedReaderImageUrl(url: string): string {
  const value = url.trim()
  if (!/^https?:\/\//i.test(value)) return value
  if (IMAGE_PROXY_HOST_PATTERN.test(value)) return value

  return `${IMAGE_PROXY_BASE_URL}?url=${encodeURIComponent(value)}&${IMAGE_PROXY_OPTIONS}`
}

export function proxiedReaderImageUrls(urls: string[]): string[] {
  return urls.map((url) => proxiedReaderImageUrl(url))
}
