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
  PagedResults,
  SearchFilter,
  SearchQuery,
  SearchResultItem,
  SearchResultsProviding,
  SortingOption,
  SourceManga,
} from '@paperback/types'

import { NineMangaClient } from './NineMangaClient'

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
    for (const cookie of cookies) {
      this.cookieStorage.setCookie(cookie)
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

  async getSearchFilters(): Promise<SearchFilter[]> {
    return []
  }

  async getSearchResults(
    query: SearchQuery,
    metadata: unknown | undefined,
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
    metadata: unknown | undefined
  ): Promise<PagedResults<DiscoverSectionItem>> {
    return this.client.getDiscoverSectionItems(section, metadata)
  }
}

export const NineManga = new NineMangaExtension()
