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
import { getText, postText, type TextResponse } from '../common/http/request'
import { normalizeUrl, pathIdFromUrl } from '../common/utils/url'
import type { DigitalTeamListingItem, DigitalTeamMangaData } from './DigitalTeamModels'
import { DigitalTeamParser } from './DigitalTeamParser'

const BASE_URL = 'https://dgtread.com'
const HTML_CACHE_TTL_MS = 5 * 60 * 1000
const MANGA_CACHE_TTL_MS = 10 * 60 * 1000
const MAX_CACHE_ENTRIES = 30

interface CacheEntry<T> {
  expiresAt: number
  value: T
}

export class DigitalTeamClient {
  private readonly parser = new DigitalTeamParser(BASE_URL)
  private readonly htmlCache = new Map<string, CacheEntry<TextResponse>>()
  private readonly htmlRequests = new Map<string, Promise<TextResponse>>()
  private readonly mangaCache = new Map<string, CacheEntry<DigitalTeamMangaData>>()

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    return this.parser.toSourceManga(await this.getMangaData(mangaId))
  }

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const data = await this.getMangaData(sourceManga.mangaId)
    console.log(`[DigitalTeam] Chapters returned: ${data.chapters.length}`)

    return data.chapters.map((chapter) => ({
      ...chapter,
      sourceManga,
    }))
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const chapterUrl = normalizeUrl(chapter.additionalInfo?.url ?? chapter.chapterId, BASE_URL)
    const response = await this.getHtml(chapterUrl, chapter.sourceManga.mangaInfo.shareUrl || BASE_URL)
    const info = this.parser.parseReaderInfo(response.body)
    const body = new URLSearchParams()
    body.set('info[manga]', info.manga)
    body.set('info[chapter]', info.chapter)
    body.set('info[ch_sub]', info.subchapter)
    body.set('info[title]', info.title)
    if (info.external) body.set('info[external]', '1')

    const pagesResponse = await postText(
      normalizeUrl('/reader/c_i', BASE_URL),
      body.toString(),
      mergeHeaders(await this.headers(chapterUrl), {
        accept: 'application/json,text/plain,*/*',
        'content-type': 'application/x-www-form-urlencoded',
        'x-requested-with': 'XMLHttpRequest',
      })
    )
    const pages = this.parser.parseReaderPages(pagesResponse.body, info.external)

    console.log(`[DigitalTeam] Reader images returned: ${pages.length}`)
    if (pages.length === 0) throw new Error('No readable pages found for this DigitalTeam chapter')

    return {
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      pages,
    }
  }

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      {
        id: 'catalog',
        title: 'Catalogo',
        subtitle: 'Serie disponibili',
        type: DiscoverSectionType.simpleCarousel,
      },
    ]
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: Metadata | undefined
  ): Promise<PagedResults<DiscoverSectionItem>> {
    void section
    void metadata

    const items = await this.seriesItems()
    if (items.length === 0) return EndOfPageResults

    return {
      items: items.map((item) => ({
        type: 'simpleCarouselItem',
        mangaId: item.mangaId,
        imageUrl: item.imageUrl,
        title: item.title,
        contentRating: ContentRating.MATURE,
      })),
      metadata: undefined,
    }
  }

  async getSearchResults(title: string): Promise<PagedResults<SearchResultItem>> {
    const query = title.trim().toLowerCase()
    const items = await this.seriesItems()
    const filtered = query
      ? items.filter((item) => item.title.toLowerCase().includes(query))
      : items

    return {
      items: filtered.map((item) => this.parser.toSearchResult(item)),
      metadata: undefined,
    }
  }

  private async seriesItems(): Promise<DigitalTeamListingItem[]> {
    const response = await this.getHtml('/reader/series')
    return this.parser.parseSeries(response.body, response.url)
  }

  private async getMangaData(mangaId: string): Promise<DigitalTeamMangaData> {
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
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
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
