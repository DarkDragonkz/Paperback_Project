export type HeaderMap = Record<string, string>

export const MOBILE_SAFARI_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
export const IMAGE_ACCEPT_HEADER = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'

export function mergeHeaders(...headers: Array<HeaderMap | undefined>): HeaderMap {
  return Object.assign({}, ...headers)
}

export function mobileImageHeaders(referer: string): HeaderMap {
  return {
    'user-agent': MOBILE_SAFARI_USER_AGENT,
    accept: IMAGE_ACCEPT_HEADER,
    referer,
  }
}

export async function defaultBrowserHeaders(baseUrl: string): Promise<HeaderMap> {
  return {
    'user-agent': await Application.getDefaultUserAgent(),
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    referer: baseUrl,
  }
}
