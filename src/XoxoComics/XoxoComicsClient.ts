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
import { uniqueBy } from '../common/utils/array'
import { normalizeUrl, pathIdFromUrl } from '../common/utils/url'
import { getText, head, type TextResponse } from './XoxoComicsHttp'
import type {
  XoxoComicsListingConfig,
  XoxoComicsListingItem,
  XoxoComicsMangaData,
} from './XoxoComicsModels'
import { XoxoComicsParser } from './XoxoComicsParser'

const BASE_URL = 'https://xoxocomic.com/'
const HTML_CACHE_TTL_MS = 5 * 60 * 1000
const MANGA_DATA_CACHE_TTL_MS = 10 * 60 * 1000
const IMAGE_AVAILABILITY_CACHE_TTL_MS = 10 * 60 * 1000
const MAX_CACHE_ENTRIES = 30
const MAX_CHAPTER_LIST_PAGES = 8
const MAX_READER_FALLBACK_PAGES = 120
const CHAPTER_LIST_PAGE_BATCH_SIZE = 4
const READER_FALLBACK_PAGE_BATCH_SIZE = 8

const SECTIONS: XoxoComicsListingConfig[] = [
  {
    id: 'trending',
    title: '🔥 Trending Comics',
    url: BASE_URL,
    itemSelector: '.items-slide .item',
    includeChapterUpdates: false,
    featured: true,
  },
  {
    id: 'latest',
    title: '📚 Latest Updates',
    url: BASE_URL,
    itemSelector: '.items .row > .item',
    includeChapterUpdates: true,
    featured: false,
  },
  {
    id: 'new',
    title: '🆕 New Comics',
    url: '/new-comic',
    itemSelector: '.items .row > .item',
    includeChapterUpdates: true,
    featured: false,
  },
  {
    id: 'popular',
    title: '⭐ Popular Comics',
    url: '/popular-comic',
    itemSelector: '.items .row > .item',
    includeChapterUpdates: false,
    featured: false,
  },
]

interface CacheEntry<T> {
  expiresAt: number
  value: T
}

export class XoxoComicsClient {
  private readonly parser = new XoxoComicsParser(BASE_URL)
  private readonly htmlCache = new Map<string, CacheEntry<TextResponse>>()
  private readonly htmlRequests = new Map<string, Promise<TextResponse>>()
  private readonly mangaDataCache = new Map<string, CacheEntry<XoxoComicsMangaData>>()
  private readonly imageAvailabilityCache = new Map<string, CacheEntry<boolean>>()

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
    const allPagesUrl = this.parser.allPagesUrl(chapterUrl)
    let pages: string[] = []

    if (allPagesUrl) {
      try {
        const allResponse = await this.getHtml(allPagesUrl, chapterUrl || BASE_URL)
        const allImages = this.parser.parseIssueImages(allResponse.body, allResponse.url)
        if (allImages.length > 0) {
          if (!(await this.firstReaderImageIsAvailable(allImages[0]))) {
            throw new Error('The image host returned HTML instead of an image for this issue.')
          }

          pages = allImages
        }
      } catch (error) {
        if (this.isImageHostHtmlError(error)) throw error

        debugLog(`[XoxoComics] All pages reader failed: ${String(error)}`)
      }
    }

    if (pages.length === 0) {
      pages = await this.getChapterPagesFromPageSelector(chapterUrl)
    }

    debugLog(`[XoxoComics] Reader images returned: ${pages.length}`)
    if (pages.length === 0) throw new Error('No readable pages were found for this issue.')
    if (!(await this.firstReaderImageIsAvailable(pages[0]))) {
      throw new Error('The image host returned HTML instead of an image for this issue.')
    }

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
      type: this.sectionType(section),
    }))
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: Metadata | undefined
  ): Promise<PagedResults<DiscoverSectionItem>> {
    const config = SECTIONS.find((candidate) => candidate.id === section.id)
    if (!config) return EndOfPageResults

    const page = this.readPage(metadata)
    const url = this.sectionUrl(config, page)
    const response = await this.getHtml(url)
    const items = this.parser
      .parseCatalogItems(response.body, config.itemSelector)
      .filter((item) => !config.includeChapterUpdates || Boolean(item.latestChapterId))

    debugLog(`[XoxoComics] Section ${section.id} page ${page} parsed items: ${items.length}`)
    if (items.length === 0) return EndOfPageResults

    return {
      items: items.map((item) => this.toDiscoverItem(config, item)),
      metadata: config.url === BASE_URL ? undefined : ({ page: page + 1 } satisfies PageMetadata),
    }
  }

  async getSearchResults(title: string): Promise<PagedResults<SearchResultItem>> {
    const query = title.trim()
    if (!query) {
      const response = await this.getHtml(BASE_URL)
      return {
        items: this.parser.parseCatalogItems(response.body, '.items .row > .item').map((item) => this.parser.toSearchResult(item)),
        metadata: undefined,
      }
    }

    const url = normalizeUrl(`/search-comic?keyword=${encodeURIComponent(query)}`, BASE_URL)
    const response = await this.getHtml(url)

    return {
      items: this.parser.parseCatalogItems(response.body, '.items .row > .item').map((item) => this.parser.toSearchResult(item)),
      metadata: undefined,
    }
  }

  private async getMangaData(mangaId: string): Promise<XoxoComicsMangaData> {
    const mangaUrl = this.mangaUrl(mangaId)
    const cachedData = this.cacheValue(this.mangaDataCache, mangaUrl)
    if (cachedData) return cachedData

    const response = await this.getHtml(mangaUrl)
    const data = this.parser.parseManga(
      response.body,
      pathIdFromUrl(response.url, BASE_URL),
      response.url
    )
    const chapters = [...data.chapters]
    const chapterPageUrls = this.parser
      .parseMangaPageUrls(response.body, response.url)
      .filter((url) => normalizeUrl(url, BASE_URL) !== normalizeUrl(response.url, BASE_URL))
      .slice(0, MAX_CHAPTER_LIST_PAGES - 1)

    for (let index = 0; index < chapterPageUrls.length; index += CHAPTER_LIST_PAGE_BATCH_SIZE) {
      const batch = chapterPageUrls.slice(index, index + CHAPTER_LIST_PAGE_BATCH_SIZE)
      const pageChapters = await Promise.all(
        batch.map(async (pageUrl) => {
          try {
            const pageResponse = await this.getHtml(pageUrl, mangaUrl)
            return this.parser.parseManga(pageResponse.body, data.mangaId, data.shareUrl).chapters
          } catch (error) {
            debugLog(`[XoxoComics] Failed to load chapter page ${pageUrl}: ${String(error)}`)
            return []
          }
        })
      )

      for (const parsedChapters of pageChapters) {
        chapters.push(...parsedChapters)
      }
    }

    data.chapters = this.withSiteSortingIndex(uniqueBy(chapters, (chapter) => chapter.chapterId))

    this.rememberCache(this.mangaDataCache, mangaUrl, data, MANGA_DATA_CACHE_TTL_MS)
    return data
  }

  private toDiscoverItem(
    config: XoxoComicsListingConfig,
    item: XoxoComicsListingItem
  ): DiscoverSectionItem {
    if (config.featured) {
      return {
        type: 'featuredCarouselItem',
        mangaId: item.mangaId,
        imageUrl: item.imageUrl,
        title: item.title,
        supertitle: this.parser.subtitleForItem(item),
        contentRating: ContentRating.MATURE,
      }
    }

    if (config.includeChapterUpdates && item.latestChapterId) {
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

  private async getChapterPagesFromPageSelector(chapterUrl: string): Promise<string[]> {
    if (!chapterUrl) return []

    const chapterResponse = await this.getHtml(chapterUrl, BASE_URL)
    const selectedAllUrl = this.parser.parseAllPagesUrl(chapterResponse.body, chapterResponse.url)
    if (selectedAllUrl) {
      try {
        const allResponse = await this.getHtml(selectedAllUrl, chapterUrl)
        const allImages = this.parser.parseIssueImages(allResponse.body, allResponse.url)
        if (allImages.length > 0) {
          if (!(await this.firstReaderImageIsAvailable(allImages[0]))) {
            throw new Error('The image host returned HTML instead of an image for this issue.')
          }

          return allImages
        }
      } catch (error) {
        if (this.isImageHostHtmlError(error)) throw error

        debugLog(`[XoxoComics] Selected all pages reader failed: ${String(error)}`)
      }
    }

    const pageUrls = this.parser
      .parseReaderPageUrls(chapterResponse.body, chapterResponse.url)
      .slice(0, MAX_READER_FALLBACK_PAGES)
    const images: string[] = []

    for (let index = 0; index < pageUrls.length; index += READER_FALLBACK_PAGE_BATCH_SIZE) {
      const batch = pageUrls.slice(index, index + READER_FALLBACK_PAGE_BATCH_SIZE)
      const pageImages = await Promise.all(
        batch.map(async (pageUrl) => {
          try {
            const pageResponse = await this.getHtml(pageUrl, chapterUrl)
            return this.parser.parseIssueImages(pageResponse.body, pageResponse.url)
          } catch (error) {
            debugLog(`[XoxoComics] Reader page fallback failed for ${pageUrl}: ${String(error)}`)
            return []
          }
        })
      )

      for (const parsedImages of pageImages) {
        images.push(...parsedImages)
      }
    }

    return uniqueBy(images, (image) => image)
  }

  private headers(referer = BASE_URL): HeaderMap {
    return {
      'user-agent': MOBILE_SAFARI_USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      referer,
    }
  }

  private imageHeaders(): HeaderMap {
    return {
      'user-agent': MOBILE_SAFARI_USER_AGENT,
      accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'accept-language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      'cache-control': 'no-cache',
      pragma: 'no-cache',
    }
  }

  private async firstReaderImageIsAvailable(url: string | undefined): Promise<boolean> {
    if (!url) return false

    const cachedValue = this.cacheValue(this.imageAvailabilityCache, url)
    if (cachedValue !== undefined) return cachedValue

    try {
      const response = await head(url, this.imageHeaders())
      const contentType = this.headerValue(response.headers, 'content-type').toLowerCase()
      const available =
        response.status >= 200 &&
        response.status < 400 &&
        !contentType.startsWith('text/html') &&
        !contentType.includes('application/json') &&
        !contentType.includes('application/xml')

      this.rememberCache(this.imageAvailabilityCache, url, available, IMAGE_AVAILABILITY_CACHE_TTL_MS)
      return available
    } catch (error) {
      debugLog(`[XoxoComics] First image availability check failed for ${url}: ${String(error)}`)
      return true
    }
  }

  private isImageHostHtmlError(error: unknown): boolean {
    return String(error).includes('XoxoComics reader: image host returned HTML')
  }

  private headerValue(headers: Record<string, string>, name: string): string {
    const match = Object.entries(headers).find(
      ([key]) => key.toLowerCase() === name.toLowerCase()
    )

    return match?.[1] ?? ''
  }

  private mangaUrl(mangaId: string): string {
    const normalized = normalizeUrl(mangaId, BASE_URL)
    if (normalized.includes('/comic/')) return normalized

    const slug = mangaId.replace(/^\/+|\/+$/g, '').replace(/^comic\//, '')
    return normalizeUrl(`/comic/${slug}`, BASE_URL)
  }

  private sectionUrl(config: XoxoComicsListingConfig, page: number): string {
    const base = normalizeUrl(config.url, BASE_URL)
    if (page <= 1) return base

    return normalizeUrl(`${config.url.replace(/\/$/, '')}/${page}`, BASE_URL)
  }

  private sectionType(section: XoxoComicsListingConfig): DiscoverSectionType {
    if (section.featured) return DiscoverSectionType.featured
    if (section.includeChapterUpdates) return DiscoverSectionType.chapterUpdates

    return DiscoverSectionType.prominentCarousel
  }

  private sectionSubtitle(sectionId: string): string {
    switch (sectionId) {
      case 'trending':
        return 'Homepage comics in focus'
      case 'latest':
        return 'Newest issue releases'
      case 'new':
        return 'Newly added comic series'
      case 'popular':
        return 'Popular comic series'
      default:
        return ''
    }
  }

  private readPage(metadata: Metadata | undefined): number {
    const page = (metadata as PageMetadata | undefined)?.page
    return typeof page === 'number' && page > 0 ? page : 1
  }

  private withSiteSortingIndex<T extends Chapter>(chapters: T[]): T[] {
    return chapters.map((chapter, index) => ({
      ...chapter,
      sortingIndex: index,
    }))
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
