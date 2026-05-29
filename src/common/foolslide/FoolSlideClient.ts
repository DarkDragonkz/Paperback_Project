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

import { defaultBrowserHeaders, mergeHeaders, type HeaderMap } from '../http/headers'
import { getText, postText, type TextResponse } from '../http/request'
import { normalizeUrl, pathIdFromUrl } from '../utils/url'
import type { FoolSlideConfig, FoolSlideListingItem, FoolSlideMangaData } from './FoolSlideModels'
import { FoolSlideParser } from './FoolSlideParser'

const HTML_CACHE_TTL_MS = 5 * 60 * 1000
const MANGA_CACHE_TTL_MS = 10 * 60 * 1000
const MAX_CACHE_ENTRIES = 30

interface CacheEntry<T> {
  expiresAt: number
  value: T
}

export class FoolSlideClient {
  private readonly parser: FoolSlideParser
  private readonly htmlCache = new Map<string, CacheEntry<TextResponse>>()
  private readonly htmlRequests = new Map<string, Promise<TextResponse>>()
  private readonly mangaCache = new Map<string, CacheEntry<FoolSlideMangaData>>()
  private rateLimitQueue: Promise<void> = Promise.resolve()
  private lastRequestAt = 0

  constructor(private readonly config: FoolSlideConfig) {
    this.parser = new FoolSlideParser(config)
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    return this.parser.toSourceManga(await this.getMangaData(mangaId))
  }

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const data = await this.getMangaData(sourceManga.mangaId)
    console.log(`[${this.config.sourceName}] Chapters returned: ${data.chapters.length}`)

    return data.chapters.map((chapter) => ({
      ...chapter,
      sourceManga,
    }))
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const chapterUrl = normalizeUrl(chapter.additionalInfo?.url ?? chapter.chapterId, this.config.baseUrl)
    const response = await this.getHtml(this.pageOneUrl(chapterUrl), chapterUrl)
    const pages = this.parser.parseChapterPages(response.body, response.url)

    console.log(`[${this.config.sourceName}] Reader images returned: ${pages.length}`)
    if (pages.length === 0) throw new Error(`No readable pages found for this ${this.config.sourceName} chapter`)

    return {
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      pages,
    }
  }

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      {
        id: 'featured',
        title: 'In evidenza',
        subtitle: 'Serie aggiornate di recente',
        type: DiscoverSectionType.featured,
      },
      {
        id: 'latest',
        title: 'Ultimi capitoli',
        subtitle: 'Aggiornamenti recenti',
        type: DiscoverSectionType.chapterUpdates,
      },
      {
        id: 'catalog',
        title: 'Catalogo',
        subtitle: 'Serie disponibili',
        type: DiscoverSectionType.prominentCarousel,
      },
    ]
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: Metadata | undefined
  ): Promise<PagedResults<DiscoverSectionItem>> {
    const page = section.id === 'featured' ? 1 : this.pageFromMetadata(metadata)
    const items = section.id === 'latest' || section.id === 'featured'
      ? await this.latestItems(page)
      : this.parser.parseDirectory(
        (await this.getHtml(this.directoryPath(page))).body,
        normalizeUrl(this.directoryPath(page), this.config.baseUrl)
      )
    if (items.length === 0) return EndOfPageResults

    const enriched = section.id === 'latest' || section.id === 'featured'
      ? await this.withThumbnails(items.slice(0, section.id === 'featured' ? 8 : 24))
      : items.filter((item) => item.imageUrl)
    return {
      items: enriched.map((item) => this.toDiscoverItem(section, item)),
      metadata: section.id === 'featured' ? undefined : { page: page + 1 },
    }
  }

  async getSearchResults(title: string): Promise<PagedResults<SearchResultItem>> {
    const query = title.trim()
    const items = query
      ? this.parser.parseDirectory((await this.search(query)).body, this.searchPath())
      : this.parser.parseDirectory((await this.getHtml(this.directoryPath(1))).body, this.directoryPath(1))

    return {
      items: items.map((item) => this.parser.toSearchResult(item)),
      metadata: undefined,
    }
  }

  private async latestItems(page: number): Promise<FoolSlideListingItem[]> {
    const path = this.config.popularUsesLatest ? this.latestPath(page) : this.latestPath(page)
    const response = await this.getHtml(path)
    return this.parser.parseLatest(response.body, response.url)
  }

  private async withThumbnails(items: FoolSlideListingItem[]): Promise<FoolSlideListingItem[]> {
    const enriched: FoolSlideListingItem[] = []

    for (const item of items) {
      if (item.imageUrl) {
        enriched.push(item)
        continue
      }

      try {
        const data = await this.getMangaData(item.mangaId)
        enriched.push({ ...item, imageUrl: data.imageUrl })
      } catch {
        enriched.push(item)
      }
    }

    return enriched.filter((item) => item.imageUrl)
  }

  private async getMangaData(mangaId: string): Promise<FoolSlideMangaData> {
    const mangaUrl = normalizeUrl(mangaId, this.config.baseUrl)
    const cached = this.cacheValue(this.mangaCache, mangaUrl)
    if (cached) return cached

    const response = await this.getHtml(mangaUrl)
    const data = this.parser.parseManga(
      response.body,
      pathIdFromUrl(response.url, this.config.baseUrl),
      response.url
    )

    this.rememberCache(this.mangaCache, mangaUrl, data, MANGA_CACHE_TTL_MS)
    return data
  }

  private async search(query: string): Promise<TextResponse> {
    const headers = mergeHeaders(await this.headers(this.searchPath()), {
      'content-type': 'application/x-www-form-urlencoded',
    })
    const body = `search=${encodeURIComponent(query)}`
    return postText(this.searchPath(), body, headers)
  }

  private toDiscoverItem(section: DiscoverSection, item: FoolSlideListingItem): DiscoverSectionItem {
    if (section.id === 'featured') {
      return {
        type: 'featuredCarouselItem',
        mangaId: item.mangaId,
        imageUrl: item.imageUrl,
        title: item.title,
        supertitle: item.latestChapterTitle,
        contentRating: ContentRating.EVERYONE,
      }
    }

    if (section.id === 'latest' && item.latestChapterId) {
      return {
        type: 'chapterUpdatesCarouselItem',
        mangaId: item.mangaId,
        chapterId: item.latestChapterId,
        imageUrl: item.imageUrl,
        title: item.title,
        subtitle: item.latestChapterTitle,
        publishDate: item.latestChapterDate,
        contentRating: ContentRating.EVERYONE,
      }
    }

    return {
      type: section.id === 'catalog' ? 'prominentCarouselItem' : 'simpleCarouselItem',
      mangaId: item.mangaId,
      imageUrl: item.imageUrl,
      title: item.title,
      subtitle: item.latestChapterTitle,
      contentRating: ContentRating.EVERYONE,
    }
  }

  private async getHtml(url: string, referer = this.config.baseUrl): Promise<TextResponse> {
    const normalizedUrl = normalizeUrl(url, this.config.baseUrl)
    const cached = this.cacheValue(this.htmlCache, normalizedUrl)
    if (cached) return cached

    const pending = this.htmlRequests.get(normalizedUrl)
    if (pending) return pending

    const request = this.withRateLimit(async () => getText(normalizedUrl, await this.headers(referer)))
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

  private directoryPath(page: number): string {
    return `${this.rootPath()}/directory/${page}/`
  }

  private latestPath(page: number): string {
    return `${this.rootPath()}/latest/${page}/`
  }

  private searchPath(): string {
    return normalizeUrl(`${this.rootPath()}/search/`, this.config.baseUrl)
  }

  private rootPath(): string {
    return `${this.config.baseUrl.replace(/\/+$/, '')}${this.config.urlModifier ?? ''}`
  }

  private pageOneUrl(chapterUrl: string): string {
    return /\/page\/\d+\/?$/i.test(chapterUrl)
      ? chapterUrl
      : `${chapterUrl.replace(/\/+$/, '')}/page/1`
  }

  private pageFromMetadata(metadata: Metadata | undefined): number {
    const page = typeof metadata === 'object' && !Array.isArray(metadata) ? metadata?.page : undefined
    return typeof page === 'number' && page > 0 ? page : 1
  }

  private async headers(referer: string): Promise<HeaderMap> {
    return mergeHeaders(await defaultBrowserHeaders(this.config.baseUrl), {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      referer,
    })
  }

  private async withRateLimit<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.rateLimitQueue
    let release: () => void = () => {}

    this.rateLimitQueue = new Promise<void>((resolve) => {
      release = resolve
    })

    await previous

    try {
      const delayMs = this.config.requestDelayMs ?? 0
      const elapsed = Date.now() - this.lastRequestAt
      if (delayMs > 0 && elapsed < delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs - elapsed))
      this.lastRequestAt = Date.now()
      return await operation()
    } finally {
      release()
    }
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
