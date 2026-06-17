import { debugLog } from '../common/utils/logging'
import { CookieStorageInterceptor, type Cookie } from '@paperback/types'
import { getNineMangaLanguageConfig, type NineMangaLanguageId } from './NineMangaLanguageConfig'
import type {
  Chapter,
  ChapterDetails,
  ChapterProviding,
  CloudflareBypassRequestProviding,
  DiscoverSection,
  DiscoverSectionItem,
  DiscoverSectionProviding,
  Extension,
  Metadata,
  PagedResults,
  Request,
  Response,
  SearchQuery,
  SearchResultItem,
  SearchResultsProviding,
  SortingOption,
  SourceManga,
} from '@paperback/types'

import { IMAGE_ACCEPT_HEADER, MOBILE_SAFARI_USER_AGENT } from '../common/http/headers'
import { ImageRequestInterceptor } from '../common/http/imageInterceptor'
import { resetCloudflareBypassState } from '../common/http/request'
import { NineMangaClient } from './NineMangaClient'

export const NINEMANGA_SOURCE_VERSION = '1.0.42'

const CLOUDFLARE_COOKIE_TTL_MS = 7 * 24 * 60 * 60 * 1000

const DEFAULT_IMAGE_HEADERS = {
  'user-agent': MOBILE_SAFARI_USER_AGENT,
  accept: IMAGE_ACCEPT_HEADER,
}

class NineMangaExtension
  implements
    Extension,
    ChapterProviding,
    SearchResultsProviding,
    DiscoverSectionProviding,
    CloudflareBypassRequestProviding
{
  private readonly config = getNineMangaLanguageConfig(this.languageId)
  private readonly cookieStorage = new CookieStorageInterceptor({ storage: 'stateManager' })
  private cookieStorageRegistered = false
  private client?: NineMangaClient
  private imageInterceptor?: ImageRequestInterceptor

  constructor(
    private readonly languageId: NineMangaLanguageId,
    private readonly sourceName: string
  ) {}

  async initialise(): Promise<void> {
    this.client = this.createClient()

    const imageHeaders = {
      ...DEFAULT_IMAGE_HEADERS,
      referer: this.config.baseUrl,
    }

    this.imageInterceptor = new ImageRequestInterceptor(`ninemanga-${this.config.id}-image-headers`, [
      { pattern: /^https?:\/\/[^/?#]*niadd\.com\//i, headers: imageHeaders },
      { pattern: /^https?:\/\/[^/?#]*movietop\.cc\//i, headers: imageHeaders },
      { pattern: /^https?:\/\/[^/?#]*nineanime\.com\/files\//i, headers: imageHeaders },
      {
        pattern:
          /^https?:\/\/[^/?#]*(?:blogspot\.com|blogger\.googleusercontent\.com|googleusercontent\.com)\//i,
        headers: imageHeaders,
      },
    ])

    this.imageInterceptor.registerInterceptor()
    Application.setRedirectHandler(Application.Selector(this, 'handleRedirect' as never))

    debugLog(`[${this.sourceName}] Initialising source ${NINEMANGA_SOURCE_VERSION} (lang=${this.config.id})`)

    if (!this.cookieStorageRegistered) {
      this.cookieStorage.registerInterceptor()
      this.cookieStorageRegistered = true
    }
  }

  private createClient(): NineMangaClient {
    return new NineMangaClient(
      () => this.config,
      (cookie) => this.cookieStorage.setCookie(cookie)
    )
  }

  private getClient(): NineMangaClient {
    if (!this.client) {
      this.client = this.createClient()
    }

    return this.client
  }

  async saveCloudflareBypassCookies(cookies: Cookie[]): Promise<void> {
    this.storeCloudflareBypassCookies(cookies)
  }

  async cloudflareBypassCompleted(
    request: Request,
    cookies: Cookie[],
    localStorage: Record<string, string>
  ): Promise<void> {
    void request
    void localStorage
    this.storeCloudflareBypassCookies(cookies)
  }

  private storeCloudflareBypassCookies(cookies: Cookie[]): void {
    let savedCookies = 0

    for (const cookie of cookies) {
      if (this.isCloudflareCookie(cookie)) {
        const normalizedCookies = this.normalizeCloudflareCookies(cookie)

        for (const normalizedCookie of normalizedCookies) {
          this.cookieStorage.setCookie(normalizedCookie)
          debugLog(
            `[${this.sourceName}] Stored Cloudflare cookie ${normalizedCookie.name} for ${normalizedCookie.domain}${normalizedCookie.path ?? '/'}`
          )
          savedCookies += 1
        }
      }
    }

    debugLog(`[${this.sourceName}] Saved ${savedCookies} Cloudflare bypass cookies`)

    if (savedCookies > 0) {
      resetCloudflareBypassState(this.config.baseUrl)
    }
  }

  async bypassCloudflareRequest(request: Request): Promise<Request> {
    debugLog(`[${this.sourceName}] Preparing Cloudflare bypass request: ${request.url}`)

    return {
      ...request,
      headers: {
        ...request.headers,
        referer: this.config.baseUrl,
        'user-agent': await Application.getDefaultUserAgent(),
      },
    }
  }

  async handleRedirect(
    proposedRequest: Request,
    redirectedResponse: Response
  ): Promise<Request | undefined> {
    if (this.isFinanceJumpRedirect(redirectedResponse)) {
      this.getClient().rememberFinanceJumpRedirect(redirectedResponse)
    }

    return proposedRequest
  }

  private isFinanceJumpRedirect(response: Response): boolean {
    return (
      response.status >= 300 &&
      response.status < 400 &&
      /^https?:\/\/(?:www\.)?financemasterpro\.com\/go\/jump\/?/i.test(response.url) &&
      /[?&]type=(?:en|es|ru)ninemanga(?:&|$)/i.test(response.url) &&
      /[?&]cid=[^&#]+/i.test(response.url)
    )
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    return this.getClient().getMangaDetails(mangaId)
  }

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    return this.getClient().getChapters(sourceManga)
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    return this.getClient().getChapterDetails(chapter)
  }

  async getSearchResults(
    query: SearchQuery<Metadata>,
    metadata: Metadata | undefined,
    sortingOption: SortingOption | undefined
  ): Promise<PagedResults<SearchResultItem>> {
    void metadata
    void sortingOption

    return this.getClient().getSearchResults(query.title)
  }

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return this.getClient().getDiscoverSections()
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: Metadata | undefined
  ): Promise<PagedResults<DiscoverSectionItem>> {
    return this.getClient().getDiscoverSectionItems(section, metadata)
  }

  private isCloudflareCookie(cookie: Cookie): boolean {
    return (
      cookie.name === 'cf_clearance' ||
      cookie.name.startsWith('cf') ||
      cookie.name.startsWith('_cf') ||
      cookie.name.startsWith('__cf')
    )
  }

  private normalizeCloudflareCookies(cookie: Cookie): Cookie[] {
    const normalizedCookie = {
      ...cookie,
      domain: cookie.domain || this.config.cookieDomain,
      path: cookie.path || '/',
      expires: cookie.expires ?? new Date(Date.now() + CLOUDFLARE_COOKIE_TTL_MS),
    }

    if (this.isNineMangaCookieDomain(normalizedCookie.domain)) return [normalizedCookie]

    return [
      normalizedCookie,
      {
        ...normalizedCookie,
        domain: this.config.cookieDomain,
      },
    ]
  }

  private isNineMangaCookieDomain(domain: string): boolean {
    return domain.replace(/^\./, '').toLowerCase().endsWith(this.config.cookieDomain)
  }
}

export function createNineMangaExtension(
  languageId: NineMangaLanguageId,
  sourceName: string
): Extension &
  ChapterProviding &
  SearchResultsProviding &
  DiscoverSectionProviding &
  CloudflareBypassRequestProviding {
  return new NineMangaExtension(languageId, sourceName)
}
