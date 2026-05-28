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
import { getText, postForm, type TextResponse } from './ReadAllComicsHttp'
import type { ReadAllComicsListingItem, ReadAllComicsMangaData } from './ReadAllComicsModels'
import { ReadAllComicsParser } from './ReadAllComicsParser'

const BASE_URL = 'https://readallcomics.com/'
const AJAX_URL = 'https://readallcomics.com/wp-admin/admin-ajax.php'
const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const HTML_CACHE_TTL_MS = 2 * 60 * 1000
const MANGA_DATA_CACHE_TTL_MS = 5 * 60 * 1000
const MAX_CACHE_ENTRIES = 30

interface CacheEntry<T> {
  expiresAt: number
  value: T
}

export class ReadAllComicsClient {
  private readonly parser = new ReadAllComicsParser(BASE_URL)
  private readonly htmlCache = new Map<string, CacheEntry<TextResponse>>()
  private readonly htmlRequests = new Map<string, Promise<TextResponse>>()
  private readonly mangaDataCache = new Map<string, CacheEntry<ReadAllComicsMangaData>>()

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    return this.parser.toSourceManga(await this.getMangaData(mangaId))
  }

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const data = await this.getMangaData(sourceManga.mangaId)

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
    if (pages.length === 0) throw new Error('No readable comic pages found for this chapter')

    return {
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      pages,
    }
  }

  private async getMangaData(mangaId: string): Promise<ReadAllComicsMangaData> {
    const mangaUrl = this.mangaUrl(mangaId)
    const cachedData = this.cacheValue(this.mangaDataCache, mangaUrl)
    if (cachedData) return cachedData

    const response = await this.getHtml(mangaUrl)
    const data = this.parser.parseManga(
      response.body,
      pathIdFromUrl(response.url, BASE_URL),
      response.url
    )

    this.rememberCache(this.mangaDataCache, mangaUrl, data, MANGA_DATA_CACHE_TTL_MS)
    return data
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
    const catalogItems = this.parser.parseCatalogItems(response.body)
    return catalogItems.length > 0 ? catalogItems : this.parser.parseAjaxSearchResults(response.body)
  }

  private async searchWithAjax(query: string): Promise<ReadAllComicsListingItem[]> {
    try {
      const homepage = await this.getHtml(BASE_URL)
      const ajaxConfig = this.parser.parseWpAjaxConfig(homepage.body)
      const nonce = ajaxConfig.nonce
      if (!nonce) {
        console.log('[ReadAllComics] AJAX search nonce not found')
        return []
      }

      const response = await postForm(
        normalizeUrl(ajaxConfig.ajaxUrl || AJAX_URL, BASE_URL),
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
    const normalizedUrl = normalizeUrl(url, BASE_URL)
    const cachedResponse = this.cacheValue(this.htmlCache, normalizedUrl)
    if (cachedResponse) return cachedResponse

    const pendingRequest = this.htmlRequests.get(normalizedUrl)
    if (pendingRequest) return pendingRequest

    const request = getText(normalizedUrl, this.headers(referer))
      .then((response) => {
        this.rememberCache(this.htmlCache, normalizedUrl, response, HTML_CACHE_TTL_MS)
        return response
      })
      .finally(() => {
        this.htmlRequests.delete(normalizedUrl)
      })

    this.htmlRequests.set(normalizedUrl, request)
    return request
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

  private cacheValue<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
    const entry = cache.get(key)
    if (!entry) return undefined

    if (entry.expiresAt <= Date.now()) {
      cache.delete(key)
      return undefined
    }

    return entry.value
  }

  private rememberCache<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    value: T,
    ttlMs: number
  ): void {
    cache.set(key, {
      expiresAt: Date.now() + ttlMs,
      value,
    })

    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = cache.keys().next().value
      if (!oldestKey) return

      cache.delete(oldestKey)
    }
  }
}
