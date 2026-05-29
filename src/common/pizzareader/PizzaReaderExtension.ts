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

import { PizzaReaderClient } from './PizzaReaderClient'
import type { PizzaReaderConfig } from './PizzaReaderModels'

class PizzaReaderExtension
  implements Extension, ChapterProviding, SearchResultsProviding, DiscoverSectionProviding
{
  private readonly client: PizzaReaderClient

  constructor(
    private readonly config: PizzaReaderConfig,
    private readonly version: string
  ) {
    this.client = new PizzaReaderClient(config)
  }

  async initialise(): Promise<void> {
    console.log(`[${this.config.sourceName}] Initialising source ${this.version}`)
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

export function createPizzaReaderExtension(
  config: PizzaReaderConfig,
  version: string
): Extension & ChapterProviding & SearchResultsProviding & DiscoverSectionProviding {
  return new PizzaReaderExtension(config, version)
}
