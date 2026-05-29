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
import { normalizeUrl, pathIdFromUrl } from '../common/utils/url'
import type { AnimeGDRClubListingItem, AnimeGDRClubMangaData } from './AnimeGDRClubModels'
import { AnimeGDRClubParser } from './AnimeGDRClubParser'

const BASE_URL = 'http://www.agcscanlation.it/'
const HTML_CACHE_TTL_MS = 5 * 60 * 1000
const MANGA_CACHE_TTL_MS = 10 * 60 * 1000
const MAX_CACHE_ENTRIES = 30

interface CacheEntry<T> {
  expiresAt: number
  value: T
}

export class AnimeGDRClubClient {
  private readonly parser = new AnimeGDRClubParser(BASE_URL)
  private readonly htmlCache = new Map<string, CacheEntry<TextResponse>>()
  private readonly htmlRequests = new Map<string, Promise<TextResponse>>()
  private readonly mangaCache = new Map<string, CacheEntry<AnimeGDRClubMangaData>>()

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    return this.parser.toSourceManga(await this.getMangaData(mangaId))
  }

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const data = await this.getMangaData(sourceManga.mangaId)
    console.log(`[AnimeGDRClub] Chapters returned: ${data.chapters.length}`)

    return data.chapters.map((chapter) => ({
      ...chapter,
      sourceManga,
    }))
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const chapterUrl = normalizeUrl(chapter.additionalInfo?.url ?? chapter.chapterId, BASE_URL)
    const response = await this.getHtml(chapterUrl, chapter.sourceManga.mangaInfo.shareUrl || BASE_URL)
    const pages = this.parser.parseChapterPages(response.body, response.url)

    console.log(`[AnimeGDRClub] Reader images returned: ${pages.length}`)
    if (pages.length === 0) throw new Error('No readable pages found for this AnimeGDRClub chapter')

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
        subtitle: 'Ultime serie aggiornate',
        type: DiscoverSectionType.featured,
      },
      {
        id: 'latest',
        title: 'Ultimi capitoli',
        subtitle: 'Aggiornamenti recenti',
        type: DiscoverSectionType.chapterUpdates,
      },
      {
        id: 'popular',
        title: 'Popolari',
        subtitle: 'Serie piu lette',
        type: DiscoverSectionType.prominentCarousel,
      },
    ]
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: Metadata | undefined
  ): Promise<PagedResults<DiscoverSectionItem>> {
    void metadata

    const items = section.id === 'latest' || section.id === 'featured'
      ? this.parser.parseLatest((await this.getHtml('/')).body, BASE_URL)
      : this.parser.parsePopular((await this.getHtml('/serie.php')).body, normalizeUrl('/serie.php', BASE_URL))
    if (items.length === 0) return EndOfPageResults

    return {
      items: items
        .filter((item) => item.imageUrl)
        .slice(0, section.id === 'featured' ? 8 : undefined)
        .map((item) => this.toDiscoverItem(section, item)),
      metadata: undefined,
    }
  }

  async getSearchResults(title: string): Promise<PagedResults<SearchResultItem>> {
    const query = title.trim().toLowerCase()
    const items = this.parser.parsePopular(
      (await this.getHtml('/serie.php')).body,
      normalizeUrl('/serie.php', BASE_URL)
    )
    const filtered = query
      ? items.filter((item) => item.title.toLowerCase().includes(query))
      : items

    return {
      items: filtered.map((item) => this.parser.toSearchResult(item)),
      metadata: undefined,
    }
  }

  private async getMangaData(mangaId: string): Promise<AnimeGDRClubMangaData> {
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
    section: DiscoverSection,
    item: AnimeGDRClubListingItem
  ): DiscoverSectionItem {
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
      type: section.id === 'popular' ? 'prominentCarouselItem' : 'simpleCarouselItem',
      mangaId: item.mangaId,
      imageUrl: item.imageUrl,
      title: item.title,
      subtitle: item.latestChapterTitle,
      contentRating: ContentRating.EVERYONE,
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
