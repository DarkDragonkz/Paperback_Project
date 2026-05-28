export function normalizeUrl(rawUrl: string | undefined, baseUrl: string): string {
  const value = rawUrl?.trim()
  if (!value) return ''
  if (/^(?:javascript|mailto|tel|data):/i.test(value) || value.startsWith('#')) return ''

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value
  if (value.startsWith('//')) return `${protocolFromUrl(baseUrl)}${value}`

  const origin = originFromUrl(baseUrl)
  if (!origin) return value

  if (value.startsWith('/')) return `${origin}${normalizePathWithSuffix(value)}`

  const basePath = pathFromUrl(baseUrl)
  const baseDirectory = basePath.endsWith('/')
    ? basePath
    : basePath.slice(0, basePath.lastIndexOf('/') + 1)

  return `${origin}${normalizePathWithSuffix(`${baseDirectory}${value}`)}`
}

export function pathIdFromUrl(rawUrl: string, baseUrl: string): string {
  const normalized = normalizeUrl(rawUrl, baseUrl)
  const origin = originFromUrl(normalized)
  const pathWithQuery = stripHash(origin ? normalized.slice(origin.length) : normalized)
  return pathWithQuery.replace(/\?waring=1$/, '')
}

export function withQueryParam(rawUrl: string, baseUrl: string, key: string, value: string): string {
  const normalized = normalizeUrl(rawUrl, baseUrl)
  const hashIndex = normalized.indexOf('#')
  const hash = hashIndex >= 0 ? normalized.slice(hashIndex) : ''
  const withoutHash = hashIndex >= 0 ? normalized.slice(0, hashIndex) : normalized
  const queryIndex = withoutHash.indexOf('?')
  const base = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash
  const query = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : ''
  const encodedKey = encodeURIComponent(key)
  const encodedValue = encodeURIComponent(value)
  let replaced = false

  const parts = query
    .split('&')
    .filter(Boolean)
    .map((part) => {
      const [partKey] = part.split('=')
      if (safeDecode(partKey) !== key) return part

      replaced = true
      return `${encodedKey}=${encodedValue}`
    })

  if (!replaced) parts.push(`${encodedKey}=${encodedValue}`)

  return `${base}?${parts.join('&')}${hash}`
}

function protocolFromUrl(url: string): string {
  const match = url.match(/^([a-z][a-z0-9+.-]*:)\/\//i)
  return match?.[1] ?? 'https:'
}

function originFromUrl(url: string): string {
  return url.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i)?.[0] ?? ''
}

function pathFromUrl(url: string): string {
  const origin = originFromUrl(url)
  const withoutOrigin = origin ? url.slice(origin.length) : url
  const path = stripQueryAndHash(withoutOrigin)
  return path.startsWith('/') ? path : `/${path}`
}

function normalizePathWithSuffix(pathWithSuffix: string): string {
  const suffixIndex = findFirstIndex(pathWithSuffix, ['?', '#'])
  const path = suffixIndex >= 0 ? pathWithSuffix.slice(0, suffixIndex) : pathWithSuffix
  const suffix = suffixIndex >= 0 ? pathWithSuffix.slice(suffixIndex) : ''
  const normalizedParts: string[] = []

  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      normalizedParts.pop()
      continue
    }

    normalizedParts.push(part)
  }

  const trailingSlash = path.endsWith('/') ? '/' : ''
  if (normalizedParts.length === 0) return `/${suffix}`

  return `/${normalizedParts.join('/')}${trailingSlash}${suffix}`
}

function stripQueryAndHash(value: string): string {
  const index = findFirstIndex(value, ['?', '#'])
  return index >= 0 ? value.slice(0, index) : value
}

function stripHash(value: string): string {
  const index = value.indexOf('#')
  return index >= 0 ? value.slice(0, index) : value
}

function findFirstIndex(value: string, chars: string[]): number {
  const indexes = chars
    .map((char) => value.indexOf(char))
    .filter((index) => index >= 0)

  return indexes.length > 0 ? Math.min(...indexes) : -1
}

function safeDecode(value: string | undefined): string {
  if (!value) return ''

  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
