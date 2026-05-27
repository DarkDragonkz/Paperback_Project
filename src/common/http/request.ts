import { CloudflareError, type Request, type Response } from '@paperback/types'

import type { HeaderMap } from './headers'

const CLOUDFLARE_BYPASS_STATE_PREFIX = 'common:http:cloudflare-bypass-requested:'
const CLOUDFLARE_BYPASS_COOLDOWN_MS = 5_000

export interface TextResponse {
  url: string
  status: number
  body: string
}

export class CloudflareBypassInProgressError extends Error {
  constructor(url: string) {
    super(`Cloudflare bypass already requested for ${hostKey(url)}. Complete it, then refresh.`)
    this.name = 'CloudflareBypassInProgressError'
  }
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
    throwCloudflareError(request)
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

export function resetCloudflareBypassState(url: string): void {
  Application.setState(undefined, cloudflareBypassStateKey(url))
}

function throwCloudflareError(request: Request): never {
  const stateKey = cloudflareBypassStateKey(request.url)
  const previousRequestTime = Application.getState(stateKey)
  const now = Date.now()

  if (
    typeof previousRequestTime === 'number' &&
    now - previousRequestTime < CLOUDFLARE_BYPASS_COOLDOWN_MS
  ) {
    throw new CloudflareBypassInProgressError(request.url)
  }

  Application.setState(now, stateKey)

  throw new CloudflareError({
    ...request,
    method: request.method ?? 'GET',
  })
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

function cloudflareBypassStateKey(url: string): string {
  return `${CLOUDFLARE_BYPASS_STATE_PREFIX}${hostKey(url)}`
}

function hostKey(url: string): string {
  return originParts(url).host.toLowerCase()
}

function originParts(url: string): { protocol: string; host: string } {
  const match = url.match(/^([a-z][a-z0-9+.-]*:)\/\/([^/?#]+)/i)

  return {
    protocol: match?.[1] ?? '',
    host: match?.[2] ?? url,
  }
}
