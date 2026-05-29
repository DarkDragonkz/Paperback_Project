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

import { ImageRequestInterceptor } from '../common/http/imageInterceptor'
import { ReadAllComicsClient } from './ReadAllComicsClient'

const SOURCE_VERSION = '1.0.1'
const BASE_URL = 'https://readallcomics.com/'
const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const BLOGSPOT_IMAGE_HEADERS = {
  'user-agent': MOBILE_USER_AGENT,
  accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  referer: BASE_URL,
}

class ReadAllComicsExtension
  implements Extension, ChapterProviding, SearchResultsProviding, DiscoverSectionProviding
{
  private readonly client = new ReadAllComicsClient()
  private readonly imageInterceptor = new ImageRequestInterceptor('readallcomics-image-headers', [
    { pattern: /^https?:\/\/[^/?#]*(?:bp\.blogspot\.com|blogspot\.com|blogger\.googleusercontent\.com)\//i, headers: BLOGSPOT_IMAGE_HEADERS },
  ])

  async initialise(): Promise<void> {
    this.imageInterceptor.registerInterceptor()
    console.log(`[ReadAllComics] Initialising source ${SOURCE_VERSION}`)
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

export const ReadAllComics = new ReadAllComicsExtension()
