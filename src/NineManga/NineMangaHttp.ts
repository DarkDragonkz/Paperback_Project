import type { Request, Response } from '@paperback/types'

import type { HeaderMap } from '../common/http/headers'
import { normalizeUrl } from '../common/utils/url'

const MAX_REDIRECTS = 5

export interface TextResponse {
  url: string
  status: number
  body: string
}

export async function getText(url: string, headers?: HeaderMap): Promise<TextResponse> {
  return requestText({ url, method: 'GET', headers }, 0)
}

async function requestText(request: Request, redirectCount: number): Promise<TextResponse> {
  const [response, data] = await Application.scheduleRequest(request)
  const body = Application.arrayBufferToUTF8String(data)

  const redirectUrl = redirectLocation(response)
  if (redirectUrl && redirectCount < MAX_REDIRECTS) {
    const nextUrl = normalizeUrl(redirectUrl, response.url || request.url)
    const nextHeaders: HeaderMap = {
      ...request.headers,
      referer: response.url || request.url,
    }

    if (!isNineMangaUrl(nextUrl)) delete nextHeaders.cookie

    return requestText(
      {
        url: nextUrl,
        method: 'GET',
        headers: nextHeaders,
      },
      redirectCount + 1
    )
  }

  if (response.status >= 400) {
    throw new Error(`NineManga request failed with HTTP ${response.status}: ${response.url || request.url}`)
  }

  return {
    url: response.url || request.url,
    status: response.status,
    body,
  }
}

function isNineMangaUrl(url: string): boolean {
  return /^https:\/\/(?:www\.|it\.|es\.|br\.|fr\.|de\.|ru\.)?ninemanga\.com\//i.test(url)
}

function redirectLocation(response: Response): string {
  if (response.status < 300 || response.status >= 400) return ''

  return headerValue(response.headers, 'location')
}

function headerValue(headers: Record<string, string>, name: string): string {
  const match = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase()
  )

  return match?.[1] ?? ''
}
