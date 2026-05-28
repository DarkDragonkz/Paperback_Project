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

import { RCOStationClient } from './RCOStationClient'

const SOURCE_VERSION = '1.0.0'

class RCOStationExtension
  implements Extension, ChapterProviding, SearchResultsProviding, DiscoverSectionProviding
{
  private readonly client = new RCOStationClient()

  async initialise(): Promise<void> {
    console.log(`[RCOStation] Initialising source ${SOURCE_VERSION}`)
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
    void metadata
    return this.client.getDiscoverSectionItems(section)
  }
}

export const RCOStation = new RCOStationExtension()
