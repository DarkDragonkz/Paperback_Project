import type { HeaderMap } from './headers'

export interface TextResponse {
  url: string
  status: number
  body: string
}

export async function getText(url: string, headers?: HeaderMap): Promise<TextResponse> {
  const [response, data] = await Application.scheduleRequest({
    url,
    method: 'GET',
    headers,
  })

  return {
    url: response.url,
    status: response.status,
    body: Application.arrayBufferToUTF8String(data),
  }
}

export async function getJson<T>(url: string, headers?: HeaderMap): Promise<T> {
  const response = await getText(url, headers)
  return JSON.parse(response.body) as T
}
