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

import { NineMangaClient } from './NineMangaClient'

const BASE_URL = 'https://www.ninemanga.com/'

class NineMangaExtension
  implements
    Extension,
    ChapterProviding,
    SearchResultsProviding,
    DiscoverSectionProviding,
    CloudflareBypassRequestProviding
{
  private readonly client = new NineMangaClient()
  private readonly cookieStorage = new CookieStorageInterceptor({ storage: 'stateManager' })
  private cookieStorageRegistered = false

  async initialise(): Promise<void> {
    if (this.cookieStorageRegistered) return

    this.cookieStorage.registerInterceptor()
    this.cookieStorageRegistered = true
  }

  async saveCloudflareBypassCookies(cookies: Cookie[]): Promise<void> {
    let savedCookies = 0

    for (const cookie of cookies) {
      if (this.isCloudflareCookie(cookie)) {
        this.cookieStorage.setCookie(cookie)
        savedCookies += 1
      }
    }

    console.log(`[NineManga] Saved ${savedCookies} Cloudflare bypass cookies`)
  }

  async bypassCloudflareRequest(request: Request): Promise<Request> {
    console.log(`[NineManga] Preparing Cloudflare bypass request: ${request.url}`)

    return {
      ...request,
      headers: {
        ...request.headers,
        Referer: BASE_URL,
        'User-Agent': await Application.getDefaultUserAgent(),
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
}

export const NineManga = new NineMangaExtension()
