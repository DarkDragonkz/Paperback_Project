import { PaperbackInterceptor, type Request, type Response } from '@paperback/types'

import type { HeaderMap } from './headers'

export interface ImageHeaderRule {
  pattern: RegExp
  headers: HeaderMap
}

export class ImageRequestInterceptor extends PaperbackInterceptor {
  constructor(id: string, private readonly rules: ImageHeaderRule[]) {
    super(id)
  }

  async interceptRequest(request: Request): Promise<Request> {
    const headers = this.headersForUrl(request.url)
    if (!headers) return request

    return {
      ...request,
      headers: {
        ...request.headers,
        ...headers,
      },
    }
  }

  async interceptResponse(
    request: Request,
    response: Response,
    data: ArrayBuffer
  ): Promise<ArrayBuffer> {
    void request
    void response
    return data
  }

  private headersForUrl(url: string): HeaderMap | undefined {
    for (const rule of this.rules) {
      if (rule.pattern.test(url)) return rule.headers
    }

    return undefined
  }
}
