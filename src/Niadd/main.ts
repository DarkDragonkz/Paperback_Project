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
import { NiaddClient } from './NiaddClient'

const SOURCE_VERSION = '1.0.0'
const BASE_URL = 'https://www.niadd.com/'
const IMAGE_HEADERS = mobileImageHeaders(BASE_URL)

class NiaddExtension
  implements Extension, ChapterProviding, SearchResultsProviding, DiscoverSectionProviding
{
  private readonly client = new NiaddClient()
  private readonly imageInterceptor = new ImageRequestInterceptor('niadd-image-headers', [
    { pattern: /^https?:\/\/img\.niadd\.com\//i, headers: IMAGE_HEADERS },
    { pattern: /^https?:\/\/img3\.yx247\.com\//i, headers: IMAGE_HEADERS },
  ])

  async initialise(): Promise<void> {
    this.imageInterceptor.registerInterceptor()
    debugLog(`[Niadd] Initialising source ${SOURCE_VERSION}`)
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
}

export const Niadd = new NiaddExtension()
