import { CookieStorageInterceptor, type Cookie } from '@paperback/types'
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
  SearchQuery,
  SearchResultItem,
  SearchResultsProviding,
  SortingOption,
  SourceManga,
} from '@paperback/types'

import { ImageRequestInterceptor } from '../common/http/imageInterceptor'
import { resetCloudflareBypassState } from '../common/http/request'
import { NineMangaClient } from './NineMangaClient'

const SOURCE_VERSION = '1.1.0'
const BASE_URL = 'https://www.ninemanga.com/'
const COOKIE_DOMAIN = 'ninemanga.com'
const CLOUDFLARE_COOKIE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const IMAGE_HEADERS = {
  'user-agent': MOBILE_USER_AGENT,
  accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  referer: BASE_URL,
}

class NineMangaExtension
  implements
    Extension,
    ChapterProviding,
    SearchResultsProviding,
    DiscoverSectionProviding,
    CloudflareBypassRequestProviding
{
  private readonly cookieStorage = new CookieStorageInterceptor({ storage: 'stateManager' })
  private cookieStorageRegistered = false
  private readonly client = new NineMangaClient((cookie) => this.cookieStorage.setCookie(cookie))
  private readonly imageInterceptor = new ImageRequestInterceptor('ninemanga-image-headers', [
    { pattern: /^https?:\/\/[^/?#]*niadd\.com\//i, headers: IMAGE_HEADERS },
    { pattern: /^https?:\/\/[^/?#]*(?:blogspot\.com|blogger\.googleusercontent\.com|googleusercontent\.com)\//i, headers: IMAGE_HEADERS },
  ])

  async initialise(): Promise<void> {
    this.imageInterceptor.registerInterceptor()
    console.log(`[NineManga] Initialising source ${SOURCE_VERSION}`)
    if (!this.cookieStorageRegistered) {
      this.cookieStorage.registerInterceptor()
      this.cookieStorageRegistered = true
    }
  }

  async saveCloudflareBypassCookies(cookies: Cookie[]): Promise<void> {
    let savedCookies = 0

    for (const cookie of cookies) {
      if (this.isCloudflareCookie(cookie)) {
        const normalizedCookies = this.normalizeCloudflareCookies(cookie)

        for (const normalizedCookie of normalizedCookies) {
          this.cookieStorage.setCookie(normalizedCookie)
          console.log(
            `[NineManga] Stored Cloudflare cookie ${normalizedCookie.name} for ${normalizedCookie.domain}${normalizedCookie.path ?? '/'}`
          )
          savedCookies += 1
        }
      }
    }

    console.log(`[NineManga] Saved ${savedCookies} Cloudflare bypass cookies`)
    if (savedCookies > 0) resetCloudflareBypassState(BASE_URL)
  }

  async bypassCloudflareRequest(request: Request): Promise<Request> {
    console.log(`[NineManga] Preparing Cloudflare bypass request: ${request.url}`)

    return {
      ...request,
      headers: {
        ...request.headers,
        referer: BASE_URL,
        'user-agent': await Application.getDefaultUserAgent(),
      },
    }
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    return this.client.getMangaDetails(mangaId)
  }

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    return this.client.getChapters(sourceManga)
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    return this.client.getChapterDetails(chapter)
  }

  async getSearchResults(
    query: SearchQuery<Metadata>,
    metadata: Metadata | undefined,
    sortingOption: SortingOption | undefined
  ): Promise<PagedResults<SearchResultItem>> {
    void metadata
    void sortingOption
    return this.client.getSearchResults(query.title)
  }

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return this.client.getDiscoverSections()
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: Metadata | undefined
  ): Promise<PagedResults<DiscoverSectionItem>> {
    return this.client.getDiscoverSectionItems(section, metadata)
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
      domain: cookie.domain || COOKIE_DOMAIN,
      path: cookie.path || '/',
      expires: cookie.expires ?? new Date(Date.now() + CLOUDFLARE_COOKIE_TTL_MS),
    }

    if (this.isNineMangaCookieDomain(normalizedCookie.domain)) return [normalizedCookie]

    return [
      normalizedCookie,
      {
        ...normalizedCookie,
        domain: COOKIE_DOMAIN,
      },
    ]
  }

  private isNineMangaCookieDomain(domain: string): boolean {
    return domain.replace(/^\./, '').toLowerCase().endsWith(COOKIE_DOMAIN)
  }
}

export const NineManga = new NineMangaExtension()
