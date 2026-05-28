import {
  ContentRating,
  DiscoverSectionType,
  EndOfPageResults,
  type Chapter,
  type ChapterDetails,
  type DiscoverSection,
  type DiscoverSectionItem,
  type Metadata,
  type PagedResults,
  type SearchResultItem,
  type SourceManga,
} from '@paperback/types'

import type { HeaderMap } from '../common/http/headers'
import type { PageMetadata } from '../common/models/Pagination'
import { uniqueBy, uniqueStrings } from '../common/utils/array'
import { normalizeUrl, pathIdFromUrl } from '../common/utils/url'
import { getText, postForm } from './ReadAllComicsHttp'
import type { ReadAllComicsListingItem } from './ReadAllComicsModels'
import { ReadAllComicsParser } from './ReadAllComicsParser'

const BASE_URL = 'https://readallcomics.com/'
const AJAX_URL = 'https://readallcomics.com/wp-admin/admin-ajax.php'
const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

export class ReadAllComicsClient {
  private readonly parser = new ReadAllComicsParser(BASE_URL)

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const response = await this.getHtml(this.mangaUrl(mangaId))
    const data = this.parser.parseManga(
      response.body,
      pathIdFromUrl(response.url, BASE_URL),
      response.url
    )

    return this.parser.toSourceManga(data)
  }

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const response = await this.getHtml(this.mangaUrl(sourceManga.mangaId))
    const data = this.parser.parseManga(
      response.body,
      pathIdFromUrl(response.url, BASE_URL),
      response.url
    )

    return data.chapters.map((chapter) => ({
      ...chapter,
      sourceManga,
    }))
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const chapterUrl = normalizeUrl(chapter.additionalInfo?.url ?? chapter.chapterId, BASE_URL)
    const response = await this.getHtml(chapterUrl)
    const pages = this.parser.parseIssueImages(response.body, response.url)

    console.log(`[ReadAllComics] Reader images returned: ${pages.length}`)

    return {
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      pages,
    }
  }

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      {
        id: 'latest',
        title: 'Latest Updates',
        type: DiscoverSectionType.chapterUpdates,
      },
    ]
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: Metadata | undefined
  ): Promise<PagedResults<DiscoverSectionItem>> {
    if (section.id !== 'latest') return EndOfPageResults

    const page = this.readPage(metadata)
    const items = await this.getLatestUpdates(page)
    if (items.length === 0) return EndOfPageResults

    return {
      items: items.map((item) => this.toDiscoverItem(item)),
      metadata: { page: page + 1 } satisfies PageMetadata,
    }
  }

  async getSearchResults(title: string): Promise<PagedResults<SearchResultItem>> {
    const query = title.trim()
    if (!query) {
      const latest = await this.getLatestUpdates(1)
      return {
        items: latest.map((item) => this.parser.toSearchResult(item)),
        metadata: undefined,
      }
    }

    const getResults = await this.searchWithGet(query)
    if (getResults.length > 0) {
      return {
        items: getResults.map((item) => this.parser.toSearchResult(item)),
        metadata: undefined,
      }
    }

    const ajaxResults = await this.searchWithAjax(query)
    return {
      items: ajaxResults.map((item) => this.parser.toSearchResult(item)),
      metadata: undefined,
    }
  }

  private async getLatestUpdates(page: number): Promise<ReadAllComicsListingItem[]> {
    const url = page <= 1 ? BASE_URL : normalizeUrl(`/?paged=${page}`, BASE_URL)
    const response = await this.getHtml(url)
    const items = this.parser.parseCatalogItems(response.body)

    console.log(`[ReadAllComics] Latest page ${page} parsed items: ${items.length}`)

    return items
  }

  private async searchWithGet(query: string): Promise<ReadAllComicsListingItem[]> {
    const url = normalizeUrl(
      `/?story=${encodeURIComponent(query)}&s=&type=comic`,
      BASE_URL
    )
    const response = await this.getHtml(url)
    return this.parser.parseCatalogItems(response.body)
  }

  private async searchWithAjax(query: string): Promise<ReadAllComicsListingItem[]> {
    try {
      const homepage = await this.getHtml(BASE_URL)
      const nonce = this.parser.parseWpAjaxNonce(homepage.body)
      if (!nonce) {
        console.log('[ReadAllComics] AJAX search nonce not found')
        return []
      }

      const response = await postForm(
        AJAX_URL,
        this.formBody({
          action: 'htp_search',
          nonce,
          key: query,
        }),
        this.headers(BASE_URL)
      )

      return this.parser.parseAjaxSearchResults(response.body)
    } catch (error) {
      console.log(`[ReadAllComics] AJAX search fallback failed: ${String(error)}`)
      return []
    }
  }

  private toDiscoverItem(item: ReadAllComicsListingItem): DiscoverSectionItem {
    if (item.latestChapterId) {
      return {
        type: 'chapterUpdatesCarouselItem',
        mangaId: item.mangaId,
        chapterId: item.latestChapterId,
        imageUrl: item.imageUrl,
        title: item.title,
        subtitle: this.parser.subtitleForItem(item),
        contentRating: ContentRating.MATURE,
      }
    }

    return {
      type: 'simpleCarouselItem',
      mangaId: item.mangaId,
      imageUrl: item.imageUrl,
      title: item.title,
      subtitle: this.parser.subtitleForItem(item),
      contentRating: ContentRating.MATURE,
    }
  }

  private async getHtml(url: string, referer = BASE_URL) {
    return getText(normalizeUrl(url, BASE_URL), this.headers(referer))
  }

  private headers(referer = BASE_URL): HeaderMap {
    return {
      'user-agent': MOBILE_USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      referer,
    }
  }

  private mangaUrl(mangaId: string): string {
    const normalized = normalizeUrl(mangaId, BASE_URL)
    if (normalized.includes('/category/')) return normalized

    const slug = mangaId.replace(/^\/+|\/+$/g, '')
    return normalizeUrl(`/category/${slug}/`, BASE_URL)
  }

  private formBody(values: Record<string, string>): string {
    return Object.entries(values)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&')
  }

  private readPage(metadata: Metadata | undefined): number {
    const page = (metadata as PageMetadata | undefined)?.page
    return typeof page === 'number' && page > 0 ? page : 1
  }
}

