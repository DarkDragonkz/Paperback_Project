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

import { getText, type TextResponse } from '../common/http/request'
import { MOBILE_SAFARI_USER_AGENT, type HeaderMap } from '../common/http/headers'
import type { PageMetadata } from '../common/models/Pagination'
import { uniqueBy } from '../common/utils/array'
import { proxiedReaderImageUrls } from '../common/utils/images'
import { normalizeUrl, pathIdFromUrl } from '../common/utils/url'
import type { NiaddListingConfig, NiaddListingItem, NiaddMangaData } from './NiaddModels'
import { NiaddParser } from './NiaddParser'

const BASE_URL = 'https://www.niadd.com/'
const HTML_CACHE_TTL_MS = 5 * 60 * 1000
const MANGA_DATA_CACHE_TTL_MS = 10 * 60 * 1000
const MAX_CACHE_ENTRIES = 30
const MAX_READER_PAGES = 80

const SECTIONS: NiaddListingConfig[] = [
  {
    id: 'latest',
    title: 'Latest Chapters',
    url: '/list/New-Update/',
    includeChapterUpdates: true,
    featured: false,
  },
  {
    id: 'popular',
    title: 'Popular Manga',
    url: '/list/Hot-Manga/',
    includeChapterUpdates: false,
    featured: true,
  },
  {
    id: 'original',
    title: 'Original Series',
    url: '/category/original/',
    includeChapterUpdates: false,
    featured: false,
  },
  {
    id: 'today',
    title: "Today's Updates",
    url: '/update/',
    includeChapterUpdates: true,
    featured: false,
  },
]

interface CacheEntry<T> {
  expiresAt: number
  value: T
}

export class NiaddClient {
  private readonly parser = new NiaddParser(BASE_URL)
  private readonly htmlCache = new Map<string, CacheEntry<TextResponse>>()
  private readonly htmlRequests = new Map<string, Promise<TextResponse>>()
  private readonly mangaDataCache = new Map<string, CacheEntry<NiaddMangaData>>()

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
    const response = await this.getHtml(chapterUrl, '')
    const pageUrls = this.parser.parseReaderPageUrls(response.body, response.url).slice(0, MAX_READER_PAGES)
    const pages = [...this.parser.parseChapterImages(response.body, response.url)]
    const loadedUrls = new Set([normalizeUrl(response.url, BASE_URL)])

    for (const pageUrl of pageUrls) {
      const normalizedPageUrl = normalizeUrl(pageUrl, BASE_URL)
      if (!normalizedPageUrl || loadedUrls.has(normalizedPageUrl)) continue

      loadedUrls.add(normalizedPageUrl)
      try {
        const pageResponse = await this.getHtml(normalizedPageUrl, '')
        pages.push(...this.parser.parseChapterImages(pageResponse.body, pageResponse.url))
      } catch (error) {
        debugLog(`[Niadd] Reader page failed for ${normalizedPageUrl}: ${String(error)}`)
      }
    }

    const uniquePages = uniqueBy(pages, (page) => page)
    debugLog(`[Niadd] Reader images returned: ${uniquePages.length}`)
    if (uniquePages.length === 0) {
      throw new Error('Niadd reader: no readable image pages found for this chapter.')
    }

    return {
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      pages: proxiedReaderImageUrls(uniquePages),
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
    const response = await this.getHtml(this.sectionUrl(config, page))
    const parsedItems = this.parser.parseCatalogItems(response.body)
    const items = config.includeChapterUpdates
      ? parsedItems.filter((item) => Boolean(item.latestChapterId))
      : parsedItems

    debugLog(`[Niadd] Section ${section.id} page ${page} parsed items: ${parsedItems.length}; usable items: ${items.length}`)
    if (items.length === 0) return EndOfPageResults

    return {
      items: items.map((item) => this.toDiscoverItem(config, item)),
      metadata: page === 1 ? ({ page: page + 1 } satisfies PageMetadata) : undefined,
    }
  }

  async getSearchResults(title: string): Promise<PagedResults<SearchResultItem>> {
    const query = title.trim()
    const url = query
      ? normalizeUrl(`/search/?search_type=1&name=${encodeURIComponent(query)}`, BASE_URL)
      : BASE_URL
    const response = await this.getHtml(url)

    return {
      items: this.parser.parseCatalogItems(response.body).map((item) => this.parser.toSearchResult(item)),
      metadata: undefined,
    }
  }

  private async getMangaData(mangaId: string): Promise<NiaddMangaData> {
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
    if (fullChapterListUrl && normalizeUrl(fullChapterListUrl, BASE_URL) !== normalizeUrl(response.url, BASE_URL)) {
      try {
        const fullListResponse = await this.getHtml(fullChapterListUrl, response.url)
        const fullListData = this.parser.parseManga(fullListResponse.body, data.mangaId, data.shareUrl)
        if (fullListData.chapters.length > data.chapters.length) data.chapters = fullListData.chapters
      } catch (error) {
        debugLog(`[Niadd] Failed to load full chapter list: ${String(error)}`)
      }
    }

    this.rememberCache(this.mangaDataCache, mangaUrl, data, MANGA_DATA_CACHE_TTL_MS)
    return data
  }

  private toDiscoverItem(
    config: NiaddListingConfig,
    item: NiaddListingItem
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

  private async getHtml(url: string, referer = BASE_URL): Promise<TextResponse> {
    const normalizedUrl = normalizeUrl(url, BASE_URL)
    if (!normalizedUrl) throw new Error('Niadd: invalid URL.')

    const cachedResponse = this.cacheValue(this.htmlCache, normalizedUrl)
    if (cachedResponse) return cachedResponse

    const pendingRequest = this.htmlRequests.get(normalizedUrl)
    if (pendingRequest) return pendingRequest

    const request = getText(normalizedUrl, this.headers(referer), 'Niadd')
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
    const headers: HeaderMap = {
      'user-agent': MOBILE_SAFARI_USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    }

    if (referer) headers.referer = referer

    return headers
  }

  private mangaUrl(mangaId: string): string {
    const normalized = this.parser.canonicalMangaUrl(mangaId)
    if (normalized) return normalized

    const slug = mangaId.replace(/^\/+|\/+$/g, '')
    return normalizeUrl(`/${slug}`, BASE_URL)
  }

  private sectionUrl(config: NiaddListingConfig, page: number): string {
    const base = normalizeUrl(config.url, BASE_URL)
    if (page <= 1) return base

    return normalizeUrl(`${config.url.replace(/\/$/, '')}/${page}.html`, BASE_URL)
  }

  private sectionType(section: NiaddListingConfig): DiscoverSectionType {
    if (section.featured) return DiscoverSectionType.featured
    if (section.includeChapterUpdates) return DiscoverSectionType.chapterUpdates

    return DiscoverSectionType.prominentCarousel
  }

  private sectionSubtitle(sectionId: string): string {
    switch (sectionId) {
      case 'latest':
        return 'Fresh chapter releases from Niadd'
      case 'popular':
        return 'Most watched titles in the directory'
      case 'original':
        return 'Original titles published on Niadd'
      case 'today':
        return 'Titles updated today'
      default:
        return ''
    }
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
