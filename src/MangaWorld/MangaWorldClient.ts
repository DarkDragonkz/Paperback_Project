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
import { normalizeUrl, pathIdFromUrl, withQueryParam } from '../common/utils/url'
import { getText, type TextResponse } from './MangaWorldHttp'
import type {
  MangaWorldListingConfig,
  MangaWorldListingItem,
  MangaWorldMangaData,
  MangaWorldPageMetadata,
} from './MangaWorldModels'
import { MangaWorldParser } from './MangaWorldParser'

const BASE_URL = 'https://www.mangaworld.mx/'
const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const HTML_CACHE_TTL_MS = 5 * 60 * 1000
const MANGA_DATA_CACHE_TTL_MS = 10 * 60 * 1000
const MAX_CACHE_ENTRIES = 30

interface CacheEntry<T> {
  expiresAt: number
  value: T
}

const SECTIONS: MangaWorldListingConfig[] = [
  {
    id: 'latest',
    title: 'Ultimi aggiornamenti',
    path: '/',
    includeChapterUpdates: true,
  },
  {
    id: 'popular',
    title: 'Piu letti',
    path: '/archive?sort=most_read',
    includeChapterUpdates: false,
  },
]

export class MangaWorldClient {
  private readonly parser = new MangaWorldParser(BASE_URL)
  private readonly htmlCache = new Map<string, CacheEntry<TextResponse>>()
  private readonly htmlRequests = new Map<string, Promise<TextResponse>>()
  private readonly mangaDataCache = new Map<string, CacheEntry<MangaWorldMangaData>>()

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const data = await this.getMangaData(mangaId)
    return this.parser.toSourceManga(data)
  }

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const data = await this.getMangaData(sourceManga.mangaId)

    return data.chapters.map((chapter) => ({
      ...chapter,
      sourceManga,
    }))
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const rawUrl = chapter.additionalInfo?.url ?? chapter.chapterId
    const chapterUrl = this.parser.normalizeReaderUrl(rawUrl)
    const response = await this.getHtml(chapterUrl)
    const pages = this.parser.parseChapterPages(response.body, response.url)

    console.log(`[MangaWorld] Reader images returned: ${pages.length}`)
    if (pages.length === 0) throw new Error('No readable pages found for this MangaWorld chapter')

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
      subtitle: section.id === 'latest' ? 'Capitoli appena pubblicati' : 'Serie piu lette sul sito',
      type: section.includeChapterUpdates
        ? DiscoverSectionType.chapterUpdates
        : DiscoverSectionType.prominentCarousel,
    }))
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: Metadata | undefined
  ): Promise<PagedResults<DiscoverSectionItem>> {
    const config = SECTIONS.find((candidate) => candidate.id === section.id)
    if (!config) return EndOfPageResults

    const pageUrl = this.readNextUrl(metadata) || normalizeUrl(config.path, BASE_URL)
    const response = await this.getHtml(pageUrl)
    const items = this.parser.parseMangaTiles(response.body, response.url)
    if (items.length === 0) return EndOfPageResults

    return {
      items: items.map((item) => this.toDiscoverItem(config, item)),
      metadata: this.nextMetadata(response.body, response.url),
    }
  }

  async getSearchResults(
    title: string,
    metadata: Metadata | undefined
  ): Promise<PagedResults<SearchResultItem>> {
    const query = title.trim()
    if (!query) {
      const response = await this.getHtml(BASE_URL)
      const latest = this.parser.parseMangaTiles(response.body, response.url)

      return {
        items: latest.map((item) => this.parser.toSearchResult(item)),
        metadata: undefined,
      }
    }

    const searchUrl =
      this.readNextUrl(metadata) ||
      withQueryParam('/archive', BASE_URL, 'keyword', query)
    const response = await this.getHtml(searchUrl)
    const items = this.parser.parseMangaTiles(response.body, response.url)

    return {
      items: items.map((item) => this.parser.toSearchResult(item)),
      metadata: this.nextMetadata(response.body, response.url),
    }
  }

  private async getMangaData(mangaId: string) {
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

  private toDiscoverItem(
    config: MangaWorldListingConfig,
    item: MangaWorldListingItem
  ): DiscoverSectionItem {
    const contentRating = this.parser.contentRatingForGenres(item.genres)

    if (config.includeChapterUpdates && item.latestChapterId) {
      return {
        type: 'chapterUpdatesCarouselItem',
        mangaId: item.mangaId,
        chapterId: item.latestChapterId,
        imageUrl: item.imageUrl,
        title: item.title,
        subtitle: [item.latestChapterTitle, item.subtitle].filter(Boolean).join(' - '),
        contentRating,
      }
    }

    return {
      type: 'simpleCarouselItem',
      mangaId: item.mangaId,
      imageUrl: item.imageUrl,
      title: item.title,
      subtitle: item.subtitle,
      contentRating: contentRating || ContentRating.EVERYONE,
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
      'accept-language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      referer,
    }
  }

  private mangaUrl(mangaId: string): string {
    return normalizeUrl(mangaId, BASE_URL)
  }

  private nextMetadata(html: string, currentUrl: string): MangaWorldPageMetadata | undefined {
    const nextUrl = this.parser.parseNextPageUrl(html, currentUrl)
    return nextUrl ? { nextUrl } : undefined
  }

  private readNextUrl(metadata: Metadata | undefined): string {
    const nextUrl = (metadata as MangaWorldPageMetadata | undefined)?.nextUrl
    return typeof nextUrl === 'string' ? nextUrl : ''
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
