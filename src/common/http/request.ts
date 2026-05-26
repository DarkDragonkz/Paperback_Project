import { CloudflareError, type Request, type Response } from '@paperback/types'

import type { HeaderMap } from './headers'

export interface TextResponse {
  url: string
  status: number
  body: string
}

export async function getText(url: string, headers?: HeaderMap): Promise<TextResponse> {
  const request: Request = {
    url,
    method: 'GET',
    headers,
  }

  const [response, data] = await Application.scheduleRequest(request)
  const body = Application.arrayBufferToUTF8String(data)

  if (isCloudflareChallenge(response, body)) {
    throw new CloudflareError(request)
  }

  return {
    url: response.url,
    status: response.status,
    body,
  }
}

export async function getJson<T>(url: string, headers?: HeaderMap): Promise<T> {
  const response = await getText(url, headers)
  return JSON.parse(response.body) as T
}

function isCloudflareChallenge(response: Response, body: string): boolean {
  const cfMitigated = headerValue(response.headers, 'cf-mitigated').toLowerCase()
  if (cfMitigated === 'challenge') return true

  const server = headerValue(response.headers, 'server').toLowerCase()
  const isCloudflareServer = server.includes('cloudflare')
  const isBlockingStatus = response.status === 403 || response.status === 503
  const normalizedBody = body.toLowerCase()
  const hasCloudflareBody =
    normalizedBody.includes('cloudflare') &&
    (normalizedBody.includes('attention required') ||
      normalizedBody.includes('cf-ray') ||
      normalizedBody.includes('challenge-platform'))

  return (isCloudflareServer && isBlockingStatus) || hasCloudflareBody
}

function headerValue(headers: Record<string, string>, name: string): string {
  const match = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase()
  )

  return match?.[1] ?? ''
}
