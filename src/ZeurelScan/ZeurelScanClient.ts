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

import { defaultBrowserHeaders, mergeHeaders, type HeaderMap } from '../common/http/headers'
import { getText, type TextResponse } from '../common/http/request'
import { uniqueStrings } from '../common/utils/array'
import { normalizeUrl, pathIdFromUrl } from '../common/utils/url'
import type {
  ZeurelScanListingConfig,
  ZeurelScanListingItem,
  ZeurelScanMangaData,
} from './ZeurelScanModels'
import { ZeurelScanParser } from './ZeurelScanParser'

const BASE_URL = 'https://www.zeurelscan.com/'
const HTML_CACHE_TTL_MS = 5 * 60 * 1000
const MANGA_CACHE_TTL_MS = 10 * 60 * 1000
const MAX_CACHE_ENTRIES = 30

interface CacheEntry<T> {
  expiresAt: number
  value: T
}

const SECTIONS: ZeurelScanListingConfig[] = [
  {
    id: 'featured',
    title: 'In evidenza',
    path: '/ultimi',
    includeChapterUpdates: false,
  },
  {
    id: 'latest',
    title: 'Ultimi capitoli',
    path: '/ultimi',
    includeChapterUpdates: true,
  },
  {
    id: 'series',
    title: 'Serie',
    path: '/series',
    includeChapterUpdates: false,
  },
]

export class ZeurelScanClient {
  private readonly parser = new ZeurelScanParser(BASE_URL)
  private readonly htmlCache = new Map<string, CacheEntry<TextResponse>>()
  private readonly htmlRequests = new Map<string, Promise<TextResponse>>()
  private readonly mangaCache = new Map<string, CacheEntry<ZeurelScanMangaData>>()

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    return this.parser.toSourceManga(await this.getMangaData(mangaId))
  }

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const data = await this.getMangaData(sourceManga.mangaId)
    console.log(`[ZeurelScan] Chapters returned: ${data.chapters.length}`)

    return data.chapters.map((chapter) => ({
      ...chapter,
      sourceManga,
    }))
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const chapterUrl = normalizeUrl(chapter.additionalInfo?.url ?? chapter.chapterId, BASE_URL)
    const response = await this.getHtml(chapterUrl, chapter.sourceManga.mangaInfo.shareUrl || BASE_URL)
    const pages = this.parser.parseChapterPages(response.body, response.url)

    console.log(`[ZeurelScan] Reader images returned: ${pages.length}`)
    if (pages.length === 0) throw new Error('No readable pages found for this ZeurelScan chapter')

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
      type: this.sectionType(section.id),
    }))
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: Metadata | undefined
  ): Promise<PagedResults<DiscoverSectionItem>> {
    void metadata

    const config = SECTIONS.find((candidate) => candidate.id === section.id)
    if (!config) return EndOfPageResults

    const response = await this.getHtml(config.path)
    const items = config.id === 'latest' || config.id === 'featured'
      ? this.parser.parseLatest(response.body, response.url)
      : this.parser.parseSeries(response.body, response.url)
    if (items.length === 0) return EndOfPageResults

    return {
      items: items
        .filter((item) => item.imageUrl)
        .slice(0, config.id === 'featured' ? 8 : undefined)
        .map((item) => this.toDiscoverItem(config, item)),
      metadata: undefined,
    }
  }

  async getSearchResults(title: string): Promise<PagedResults<SearchResultItem>> {
    const query = title.trim().toLowerCase()
    const response = await this.getHtml('/series')
    const allItems = this.parser.parseSeries(response.body, response.url)
    const items = query
      ? allItems.filter((item) => item.title.toLowerCase().includes(query))
      : allItems

    return {
      items: items.map((item) => this.parser.toSearchResult(item)),
      metadata: undefined,
    }
  }

  private async getMangaData(mangaId: string): Promise<ZeurelScanMangaData> {
    const mangaUrl = normalizeUrl(mangaId, BASE_URL)
    const cached = this.cacheValue(this.mangaCache, mangaUrl)
    if (cached) return cached

    const response = await this.getHtml(mangaUrl)
    const data = this.parser.parseManga(
      response.body,
      pathIdFromUrl(response.url, BASE_URL),
      response.url
    )

    this.rememberCache(this.mangaCache, mangaUrl, data, MANGA_CACHE_TTL_MS)
    return data
  }

  private toDiscoverItem(
    config: ZeurelScanListingConfig,
    item: ZeurelScanListingItem
  ): DiscoverSectionItem {
    if (config.id === 'featured') {
      return {
        type: 'featuredCarouselItem',
        mangaId: item.mangaId,
        imageUrl: item.imageUrl,
        title: item.title,
        supertitle: item.latestChapterTitle,
        contentRating: ContentRating.EVERYONE,
      }
    }

    if (config.includeChapterUpdates && item.latestChapterId) {
      return {
        type: 'chapterUpdatesCarouselItem',
        mangaId: item.mangaId,
        chapterId: item.latestChapterId,
        imageUrl: item.imageUrl,
        title: item.title,
        subtitle: item.latestChapterTitle,
        contentRating: ContentRating.EVERYONE,
      }
    }

    return {
      type: config.id === 'series' ? 'prominentCarouselItem' : 'simpleCarouselItem',
      mangaId: item.mangaId,
      imageUrl: item.imageUrl,
      title: item.title,
      subtitle: item.latestChapterTitle,
      contentRating: ContentRating.EVERYONE,
    }
  }

  private sectionType(sectionId: string): DiscoverSectionType {
    if (sectionId === 'featured') return DiscoverSectionType.featured
    if (sectionId === 'latest') return DiscoverSectionType.chapterUpdates
    if (sectionId === 'series') return DiscoverSectionType.prominentCarousel

    return DiscoverSectionType.simpleCarousel
  }

  private sectionSubtitle(sectionId: string): string {
    switch (sectionId) {
      case 'featured':
        return 'Serie aggiornate in homepage'
      case 'latest':
        return 'Capitoli appena pubblicati'
      case 'series':
        return 'Catalogo serie'
      default:
        return ''
    }
  }

  private async getHtml(url: string, referer = BASE_URL): Promise<TextResponse> {
    const normalizedUrl = normalizeUrl(url, BASE_URL)
    const cached = this.cacheValue(this.htmlCache, normalizedUrl)
    if (cached) return cached

    const pending = this.htmlRequests.get(normalizedUrl)
    if (pending) return pending

    const request = getText(normalizedUrl, await this.headers(referer))
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

  private async headers(referer: string): Promise<HeaderMap> {
    return mergeHeaders(await defaultBrowserHeaders(BASE_URL), {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      referer,
    })
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
