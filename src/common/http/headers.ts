export type HeaderMap = Record<string, string>

export function mergeHeaders(...headers: Array<HeaderMap | undefined>): HeaderMap {
  return Object.assign({}, ...headers)
}

export async function defaultBrowserHeaders(baseUrl: string): Promise<HeaderMap> {
  return {
    'user-agent': await Application.getDefaultUserAgent(),
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    referer: baseUrl,
  }
}
