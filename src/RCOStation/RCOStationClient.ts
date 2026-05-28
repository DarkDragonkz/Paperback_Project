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
import { normalizeUrl, pathIdFromUrl } from '../common/utils/url'
import { getText, postForm, type TextResponse } from './RCOStationHttp'
import type {
  RCOStationComicData,
  RCOStationListingConfig,
  RCOStationListingItem,
} from './RCOStationModels'
import { RCOStationParser } from './RCOStationParser'

const BASE_URL = 'https://rcostation.xyz/'
const SEARCH_URL = 'https://rcostation.xyz/Search/Comic'
const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const HTML_CACHE_TTL_MS = 2 * 60 * 1000
const COMIC_DATA_CACHE_TTL_MS = 5 * 60 * 1000
const MAX_CACHE_ENTRIES = 30

interface CacheEntry<T> {
  expiresAt: number
  value: T
}

const SECTIONS: RCOStationListingConfig[] = [
  {
    id: 'latest',
    title: 'Latest update',
    heading: 'Latest update',
    includeChapterUpdates: true,
  },
  {
    id: 'new',
    title: 'New comic',
    heading: 'New comic',
    includeChapterUpdates: false,
  },
  {
    id: 'popular',
    title: 'Most popular',
    heading: 'Most popular',
    includeChapterUpdates: false,
  },
]

export class RCOStationClient {
  private readonly parser = new RCOStationParser(BASE_URL)
  private readonly htmlCache = new Map<string, CacheEntry<TextResponse>>()
  private readonly htmlRequests = new Map<string, Promise<TextResponse>>()
  private readonly comicDataCache = new Map<string, CacheEntry<RCOStationComicData>>()

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    return this.parser.toSourceManga(await this.getComicData(mangaId))
  }

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const data = await this.getComicData(sourceManga.mangaId)

    return data.chapters.map((chapter) => ({
      ...chapter,
      sourceManga,
    }))
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const rawUrl = chapter.additionalInfo?.url ?? chapter.chapterId
    const pages = await this.getReaderPages(rawUrl)

    console.log(`[RCOStation] Reader images returned: ${pages.length}`)
    if (pages.length === 0) throw new Error('No readable pages found for this RCOStation issue')

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
      type: section.includeChapterUpdates
        ? DiscoverSectionType.chapterUpdates
        : DiscoverSectionType.simpleCarousel,
    }))
  }

  async getDiscoverSectionItems(section: DiscoverSection): Promise<PagedResults<DiscoverSectionItem>> {
    const config = SECTIONS.find((candidate) => candidate.id === section.id)
    if (!config) return EndOfPageResults

    const response = await this.getHtml(BASE_URL)
    const items = this.parser.parseHomepageSection(response.body, config.heading, response.url)
    if (items.length === 0) return EndOfPageResults

    return {
      items: items.map((item) => this.toDiscoverItem(config, item)),
      metadata: undefined,
    }
  }

  async getSearchResults(title: string): Promise<PagedResults<SearchResultItem>> {
    const query = title.trim()
    if (!query) {
      const response = await this.getHtml(BASE_URL)
      const latest = this.parser.parseHomepageSection(response.body, SECTIONS[0].heading, response.url)

      return {
        items: latest.map((item) => this.parser.toSearchResult(item)),
        metadata: undefined,
      }
    }

    const response = await this.postSearch(query)
    const items = this.parser.parseSearchResults(response.body, response.url)

    return {
      items: items.map((item) => this.parser.toSearchResult(item)),
      metadata: undefined,
    }
  }

  private async getComicData(mangaId: string): Promise<RCOStationComicData> {
    const comicUrl = this.comicUrl(mangaId)
    const cachedData = this.cacheValue(this.comicDataCache, comicUrl)
    if (cachedData) return cachedData

    const response = await this.getHtml(comicUrl)
    const data = this.parser.parseComic(
      response.body,
      pathIdFromUrl(response.url, BASE_URL),
      response.url
    )

    this.rememberCache(this.comicDataCache, comicUrl, data, COMIC_DATA_CACHE_TTL_MS)
    return data
  }

  private async getReaderPages(rawUrl: string): Promise<string[]> {
    const candidates = [
      this.parser.normalizeIssueUrl(rawUrl, '', 'hq'),
      this.parser.serverIssueUrl(rawUrl, 's2', 'hq'),
      this.parser.serverIssueUrl(rawUrl, '', 'lq'),
      this.parser.serverIssueUrl(rawUrl, 's2', 'lq'),
    ]
    const attempted = new Set<string>()

    for (const candidate of candidates) {
      if (!candidate || attempted.has(candidate)) continue

      attempted.add(candidate)
      const response = await this.getHtml(candidate)
      const pages = this.parser.parseReaderPages(response.body, response.url)
      if (pages.length > 0) return pages
    }

    return []
  }

  private toDiscoverItem(
    config: RCOStationListingConfig,
    item: RCOStationListingItem
  ): DiscoverSectionItem {
    if (config.includeChapterUpdates && item.latestChapterId) {
      return {
        type: 'chapterUpdatesCarouselItem',
        mangaId: item.mangaId,
        chapterId: item.latestChapterId,
        imageUrl: item.imageUrl,
        title: item.title,
        subtitle: item.subtitle,
        contentRating: ContentRating.MATURE,
      }
    }

    return {
      type: 'simpleCarouselItem',
      mangaId: item.mangaId,
      imageUrl: item.imageUrl,
      title: item.title,
      subtitle: item.subtitle,
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

  private async postSearch(query: string): Promise<TextResponse> {
    const cacheKey = `${SEARCH_URL}?keyword=${encodeURIComponent(query)}`
    const cachedResponse = this.cacheValue(this.htmlCache, cacheKey)
    if (cachedResponse) return cachedResponse

    const pendingRequest = this.htmlRequests.get(cacheKey)
    if (pendingRequest) return pendingRequest

    const request = postForm(
      SEARCH_URL,
      `keyword=${encodeURIComponent(query)}`,
      this.headers(BASE_URL)
    )
      .then((response) => {
        this.rememberCache(this.htmlCache, cacheKey, response, HTML_CACHE_TTL_MS)
        return response
      })
      .finally(() => {
        this.htmlRequests.delete(cacheKey)
      })

    this.htmlRequests.set(cacheKey, request)
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

  private comicUrl(mangaId: string): string {
    return normalizeUrl(mangaId, BASE_URL)
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
