import { PaperbackInterceptor, type Request, type Response } from '@paperback/types'

import { IMAGE_ACCEPT_HEADER, MOBILE_SAFARI_USER_AGENT } from '../common/http/headers'

const BASE_URL = 'https://weebcentral.com/'
const WEEBCENTRAL_PATTERN = /^https?:\/\/weebcentral\.com\//i
const IMAGE_HOST_PATTERN = /^https?:\/\/(?:(?:[^/?#]+\.)?(?:lowee|planeptune)\.us|temp\.compsci88\.com)\//i

export class WeebCentralInterceptor extends PaperbackInterceptor {
  async interceptRequest(request: Request): Promise<Request> {
    if (!this.shouldHandle(request.url)) return request

    return {
      ...request,
      headers: {
        ...request.headers,
        'user-agent': MOBILE_SAFARI_USER_AGENT,
        referer: BASE_URL,
        ...(this.isImageHost(request.url) ? { accept: IMAGE_ACCEPT_HEADER } : {}),
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

  private shouldHandle(url: string): boolean {
    return WEEBCENTRAL_PATTERN.test(url) || this.isImageHost(url)
  }

  private isImageHost(url: string): boolean {
    return IMAGE_HOST_PATTERN.test(url)
  }
}
