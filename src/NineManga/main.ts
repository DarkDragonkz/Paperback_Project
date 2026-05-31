import { CookieStorageInterceptor, type Cookie } from '@paperback/types'
import { getNineMangaLanguageConfig, type NineMangaLanguageConfig } from './NineMangaLanguageConfig'
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

import { ImageRequestInterceptor } from '../common/http/imageInterceptor'
import { resetCloudflareBypassState } from '../common/http/request'
import { NineMangaClient } from './NineMangaClient'
import { registerNineMangaSettings } from './NineMangaSettings'

const SOURCE_VERSION = '1.1.0'
const CLOUDFLARE_COOKIE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

function readLanguageSetting(): NineMangaLanguageConfig['id'] {
  let id: NineMangaLanguageConfig['id'] = 'en'
  try {
    // Best-effort: try a couple of Application APIs if available
    // @ts-ignore
    const settings = (Application as any).getSettings?.() || (Application as any).getSourceSettings?.() || (Application as any).getPreferences?.()
    if (settings && settings['ninemanga.language']) id = settings['ninemanga.language']
    // @ts-ignore
    const single = (Application as any).getSetting?.('ninemanga.language')
    if (single) id = single
  } catch {
    // ignore
  }

  return id
}

const DEFAULT_IMAGE_HEADERS = {
  'user-agent': MOBILE_USER_AGENT,
  accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
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
  private client?: NineMangaClient
  private imageInterceptor?: ImageRequestInterceptor

  async initialise(): Promise<void> {
    registerNineMangaSettings()
    const activeConfig = getNineMangaLanguageConfig(readLanguageSetting())

    this.client = new NineMangaClient(() => getNineMangaLanguageConfig(readLanguageSetting()), (cookie) => this.cookieStorage.setCookie(cookie))

    const imageHeaders = {
      ...DEFAULT_IMAGE_HEADERS,
      referer: activeConfig.baseUrl,
    }

    this.imageInterceptor = new ImageRequestInterceptor('ninemanga-image-headers', [
      { pattern: /^https?:\/\/[^/?#]*niadd\.com\//i, headers: imageHeaders },
      { pattern: /^https?:\/\/[^/?#]*movietop\.cc\//i, headers: imageHeaders },
      { pattern: /^https?:\/\/[^/?#]*nineanime\.com\/files\//i, headers: imageHeaders },
      { pattern: /^https?:\/\/[^/?#]*(?:blogspot\.com|blogger\.googleusercontent\.com|googleusercontent\.com)\//i, headers: imageHeaders },
    ])

    this.imageInterceptor.registerInterceptor()
    Application.setRedirectHandler(Application.Selector(this, 'handleRedirect' as never))
    console.log(`[NineManga] Initialising source ${SOURCE_VERSION} (lang=${activeConfig.id})`)
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
    if (savedCookies > 0) {
      const cfg = getNineMangaLanguageConfig(readLanguageSetting())
      resetCloudflareBypassState(cfg.baseUrl)
    }
  }

  async bypassCloudflareRequest(request: Request): Promise<Request> {
    console.log(`[NineManga] Preparing Cloudflare bypass request: ${request.url}`)

    const cfg = getNineMangaLanguageConfig(readLanguageSetting())
    return {
      ...request,
      headers: {
        ...request.headers,
        referer: cfg.baseUrl,
        'user-agent': await Application.getDefaultUserAgent(),
      },
    }
  }

  async handleRedirect(proposedRequest: Request, redirectedResponse: Response): Promise<Request | undefined> {
    if (this.isFinanceJumpRedirect(redirectedResponse) && this.client) {
      this.client.rememberFinanceJumpRedirect(redirectedResponse)
    }

    return proposedRequest
  }

  private isFinanceJumpRedirect(response: Response): boolean {
    return (
      response.status >= 300 &&
      response.status < 400 &&
      /^https?:\/\/(?:www\.)?financemasterpro\.com\/go\/jump\/?/i.test(response.url) &&
      /[?&]type=enninemanga(?:&|$)/i.test(response.url) &&
      /[?&]cid=[^&#]+/i.test(response.url)
    )
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
    const cfg = getNineMangaLanguageConfig(readLanguageSetting())
    const COOKIE_DOMAIN = cfg.cookieDomain
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
    const cd = getNineMangaLanguageConfig(readLanguageSetting()).cookieDomain
    return domain.replace(/^\./, '').toLowerCase().endsWith(cd)
  }
}

export const NineManga = new NineMangaExtension()
