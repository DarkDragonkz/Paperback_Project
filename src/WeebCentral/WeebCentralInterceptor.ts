import { PaperbackInterceptor, type Request, type Response } from '@paperback/types'

const BASE_URL = 'https://weebcentral.com/'
const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const IMAGE_ACCEPT = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
const WEEBCENTRAL_PATTERN = /^https?:\/\/weebcentral\.com\//i
const IMAGE_HOST_PATTERN = /^https?:\/\/(?:(?:[^/?#]+\.)?planeptune\.us|temp\.compsci88\.com)\//i

export class WeebCentralInterceptor extends PaperbackInterceptor {
  async interceptRequest(request: Request): Promise<Request> {
    if (!this.shouldHandle(request.url)) return request

    return {
      ...request,
      headers: {
        ...request.headers,
        'user-agent': MOBILE_USER_AGENT,
        referer: BASE_URL,
        ...(this.isImageHost(request.url) ? { accept: IMAGE_ACCEPT } : {}),
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
