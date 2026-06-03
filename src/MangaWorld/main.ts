import { debugLog } from '../common/utils/logging'
import type {
  Chapter,
  ChapterDetails,
  ChapterProviding,
  DiscoverSection,
  DiscoverSectionItem,
  DiscoverSectionProviding,
  Extension,
  Metadata,
  PagedResults,
  SearchQuery,
  SearchResultItem,
  SearchResultsProviding,
  SortingOption,
  SourceManga,
} from '@paperback/types'

import { mobileImageHeaders } from '../common/http/headers'
import { ImageRequestInterceptor } from '../common/http/imageInterceptor'
import { MangaWorldClient } from './MangaWorldClient'

const SOURCE_VERSION = '1.0.0'
const BASE_URL = 'https://www.mangaworld.mx/'
const CDN_IMAGE_HEADERS = mobileImageHeaders(BASE_URL)

class MangaWorldExtension
  implements Extension, ChapterProviding, SearchResultsProviding, DiscoverSectionProviding
{
  private readonly client = new MangaWorldClient()
  private readonly imageInterceptor = new ImageRequestInterceptor('mangaworld-image-headers', [
    { pattern: /^https?:\/\/cdn\.mangaworld\.mx\//i, headers: CDN_IMAGE_HEADERS },
  ])

  async initialise(): Promise<void> {
    this.imageInterceptor.registerInterceptor()
    debugLog(`[MangaWorld] Initialising source ${SOURCE_VERSION}`)
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
    void sortingOption
    return this.client.getSearchResults(query.title, metadata, query.metadata)
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
}

export const MangaWorld = new MangaWorldExtension()
