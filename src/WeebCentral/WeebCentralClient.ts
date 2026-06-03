import { debugLog } from '../common/utils/logging'
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

import { MOBILE_SAFARI_USER_AGENT, type HeaderMap } from '../common/http/headers'
import type { PageMetadata } from '../common/models/Pagination'
import { normalizeUrl, pathIdFromUrl } from '../common/utils/url'
import { getText, postForm, type TextResponse } from './WeebCentralHttp'
import type {
  WeebCentralListingConfig,
  WeebCentralListingItem,
  WeebCentralMangaData,
} from './WeebCentralModels'
import { WeebCentralParser } from './WeebCentralParser'

const BASE_URL = 'https://weebcentral.com/'
const HTML_CACHE_TTL_MS = 5 * 60 * 1000
const MANGA_DATA_CACHE_TTL_MS = 10 * 60 * 1000
const MAX_CACHE_ENTRIES = 30

const SECTIONS: WeebCentralListingConfig[] = [
  {
    id: 'hot',
    title: '🔥 Popular Series',
    url: '/hot-series?sort=monthly_views',
    paged: false,
  },
  {
    id: 'recent',
    title: '🆕 Recently Added',
    url: '/recently-added',
    paged: true,
  },
]

interface CacheEntry<T> {
  expiresAt: number
  value: T
}

export class WeebCentralClient {
  private readonly parser = new WeebCentralParser(BASE_URL)
  private readonly htmlCache = new Map<string, CacheEntry<TextResponse>>()
  private readonly htmlRequests = new Map<string, Promise<TextResponse>>()
  private readonly mangaDataCache = new Map<string, CacheEntry<WeebCentralMangaData>>()

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
    const chapterUrl = this.parser.canonicalChapterUrl(chapter.additionalInfo?.url ?? chapter.chapterId)
    const imagesUrl = this.parser.chapterImagesUrl(chapterUrl)
    const response = await this.getHtml(imagesUrl || chapterUrl, chapterUrl || BASE_URL)
    const pages = this.parser.parseChapterImages(response.body, response.url)

    debugLog(`[WeebCentral] Reader images returned: ${pages.length}`)
    if (pages.length === 0) throw new Error('No readable pages were found for this chapter.')

    return {
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      pages,
    }
  }

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return SECTIONS.map((section) => ({
      id: section.id,
      title: section.title,
      subtitle: this.sectionSubtitle(section.id),
      type: DiscoverSectionType.prominentCarousel,
    }))
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: Metadata | undefined
  ): Promise<PagedResults<DiscoverSectionItem>> {
    const config = SECTIONS.find((candidate) => candidate.id === section.id)
    if (!config) return EndOfPageResults

    const page = this.readPage(metadata)
    const response = await this.getHtml(this.sectionUrl(config, page))
    const items = this.parser.parseCatalogItems(response.body)

    debugLog(`[WeebCentral] Section ${section.id} page ${page} parsed items: ${items.length}`)
    if (items.length === 0) return EndOfPageResults

    return {
      items: items.map((item) => this.toDiscoverItem(item)),
      metadata: config.paged ? ({ page: page + 1 } satisfies PageMetadata) : undefined,
    }
  }

  async getSearchResults(title: string): Promise<PagedResults<SearchResultItem>> {
    const query = title.trim()
    if (!query) {
      const response = await this.getHtml('/hot-series?sort=monthly_views')
      return {
        items: this.parser.parseCatalogItems(response.body).map((item) => this.parser.toSearchResult(item)),
        metadata: undefined,
      }
    }

    const response = await postForm(
      normalizeUrl('/search/simple?location=main', BASE_URL),
      this.formBody({ text: query }),
      this.headers(BASE_URL)
    )
    const items = this.parser.parseCatalogItems(response.body)

    return {
      items: items.map((item) => this.parser.toSearchResult(item)),
      metadata: undefined,
    }
  }

  private async getMangaData(mangaId: string): Promise<WeebCentralMangaData> {
    const mangaUrl = this.mangaUrl(mangaId)
    const cachedData = this.cacheValue(this.mangaDataCache, mangaUrl)
    if (cachedData) return cachedData

    const response = await this.getHtml(mangaUrl)
    const data = this.parser.parseManga(
      response.body,
      pathIdFromUrl(response.url, BASE_URL),
      response.url
    )

    const fullChapterListUrl = this.parser.parseFullChapterListUrl(response.body, response.url)
    if (fullChapterListUrl) {
      try {
        const fullListResponse = await this.getHtml(fullChapterListUrl, response.url)
        const fullListData = this.parser.parseManga(
          fullListResponse.body,
          data.mangaId,
          data.shareUrl
        )
        if (fullListData.chapters.length > data.chapters.length) data.chapters = fullListData.chapters
      } catch (error) {
        debugLog(`[WeebCentral] Failed to load full chapter list: ${String(error)}`)
      }
    }

    this.rememberCache(this.mangaDataCache, mangaUrl, data, MANGA_DATA_CACHE_TTL_MS)
    return data
  }

  private toDiscoverItem(item: WeebCentralListingItem): DiscoverSectionItem {
    return {
      type: 'simpleCarouselItem',
      mangaId: item.mangaId,
      imageUrl: item.imageUrl,
      title: item.title,
      contentRating: ContentRating.MATURE,
    }
  }

  private async getHtml(url: string, referer = BASE_URL): Promise<TextResponse> {
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
      'user-agent': MOBILE_SAFARI_USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      referer,
    }
  }

  private mangaUrl(mangaId: string): string {
    const normalized = normalizeUrl(mangaId, BASE_URL)
    if (normalized.includes('/series/')) return normalized

    const slug = mangaId.replace(/^\/+|\/+$/g, '').replace(/^series\//, '')
    return normalizeUrl(`/series/${slug}`, BASE_URL)
  }

  private sectionUrl(config: WeebCentralListingConfig, page: number): string {
    if (!config.paged) return normalizeUrl(config.url, BASE_URL)

    return normalizeUrl(`${config.url}/${page}`, BASE_URL)
  }

  private sectionSubtitle(sectionId: string): string {
    switch (sectionId) {
      case 'hot':
        return 'Trending manga on WeebCentral'
      case 'recent':
        return 'New manga added to the catalog'
      default:
        return ''
    }
  }

  private readPage(metadata: Metadata | undefined): number {
    const page = (metadata as PageMetadata | undefined)?.page
    return typeof page === 'number' && page > 0 ? page : 1
  }

  private formBody(values: Record<string, string>): string {
    return Object.entries(values)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&')
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
