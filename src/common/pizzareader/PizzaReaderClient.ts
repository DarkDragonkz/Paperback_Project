import {
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
import { getJson } from '../http/request'
import type {
  PizzaReaderChapter,
  PizzaReaderChapterResponse,
  PizzaReaderComic,
  PizzaReaderComicListResponse,
  PizzaReaderComicResponse,
  PizzaReaderConfig,
  PizzaReaderListingConfig,
} from './PizzaReaderModels'
import { PizzaReaderParser } from './PizzaReaderParser'

const API_CACHE_TTL_MS = 5 * 60 * 1000
const MANGA_CACHE_TTL_MS = 10 * 60 * 1000
const MAX_CACHE_ENTRIES = 30
const MAX_GENRES = 16

interface CacheEntry<T> {
  expiresAt: number
  value: T
}

const SECTIONS: PizzaReaderListingConfig[] = [
  {
    id: 'featured',
    title: 'In evidenza',
    includeChapterUpdates: false,
  },
  {
    id: 'latest',
    title: 'Ultimi capitoli',
    includeChapterUpdates: true,
  },
  {
    id: 'popular',
    title: 'Catalogo',
    includeChapterUpdates: false,
  },
]

export class PizzaReaderClient {
  private readonly parser: PizzaReaderParser
  private readonly apiCache = new Map<string, CacheEntry<unknown>>()
  private readonly apiRequests = new Map<string, Promise<unknown>>()
  private readonly mangaCache = new Map<string, CacheEntry<PizzaReaderComic>>()
  private lastRequestAt = 0
  private rateLimitQueue: Promise<void> = Promise.resolve()

  constructor(private readonly config: PizzaReaderConfig) {
    this.parser = new PizzaReaderParser(config)
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    return this.parser.toSourceManga(await this.getComic(mangaId))
  }

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const comic = await this.getComic(sourceManga.mangaId)
    const chapters = this.parser.toChapters(comic.chapters ?? [], sourceManga)

    console.log(`[${this.config.sourceName}] Chapters returned: ${chapters.length}`)
    return chapters
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const endpoints = await this.chapterReaderEndpoints(chapter)
    let pages: string[] = []

    for (const endpoint of endpoints) {
      const result = await this.getApi<PizzaReaderChapterResponse>(endpoint, 0)
      pages = this.parser.chapterPages(result.chapter)
      console.log(
        `[${this.config.sourceName}] Reader endpoint ${endpoint} returned ${pages.length} images`
      )

      if (pages.length > 0) break
    }

    console.log(`[${this.config.sourceName}] Reader images returned: ${pages.length}`)
    if (pages.length === 0) throw new Error(`No readable pages found for this ${this.config.sourceName} chapter`)

    return {
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      pages,
    }
  }

  private async chapterReaderEndpoints(chapter: Chapter): Promise<string[]> {
    const rawPath = chapter.additionalInfo?.url || chapter.chapterId
    const endpoints = [
      this.apiEndpoint(rawPath),
      this.apiEndpoint(this.withSubchapter(rawPath, chapter.additionalInfo?.subchapter)),
    ]

    const refreshedChapter = await this.findCurrentChapter(chapter)
    if (refreshedChapter?.url) {
      endpoints.push(this.apiEndpoint(refreshedChapter.url))
      endpoints.push(this.apiEndpoint(this.withSubchapter(refreshedChapter.url, chapter.additionalInfo?.subchapter)))
    }

    return [...new Set(endpoints.filter((endpoint) => endpoint !== '/api/'))]
  }

  private async findCurrentChapter(chapter: Chapter): Promise<PizzaReaderChapter | undefined> {
    try {
      const comic = await this.getComic(chapter.sourceManga.mangaId)
      const chapters = comic.chapters ?? []
      const storedPath = this.normalizedPath(chapter.additionalInfo?.url || chapter.chapterId)

      return chapters.find((candidate) => this.normalizedPath(candidate.url ?? '') === storedPath) ||
        chapters.find((candidate) =>
          candidate.volume === chapter.volume &&
          this.chapterNumber(candidate) === chapter.chapNum
        ) ||
        chapters.find((candidate) => candidate.full_title === chapter.title)
    } catch (error) {
      console.log(`[${this.config.sourceName}] Could not refresh chapter URL: ${String(error)}`)
      return undefined
    }
  }

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    const sections: DiscoverSection[] = [
      ...SECTIONS.map((section) => ({
        id: section.id,
        title: section.title,
        subtitle: this.sectionSubtitle(section.id),
        type: this.sectionType(section.id),
      })),
    ]

    if (await this.hasGenres()) {
      sections.push({
        id: 'genres',
        title: 'Generi',
        subtitle: 'Esplora per genere',
        type: DiscoverSectionType.genres,
      })
    }

    return sections
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: Metadata | undefined
  ): Promise<PagedResults<DiscoverSectionItem>> {
    void metadata

    const config = SECTIONS.find((candidate) => candidate.id === section.id)
    if (!config && section.id !== 'genres') return EndOfPageResults

    const allComics = await this.getComics()
    if (section.id === 'genres') {
      const items = this.genreItems(allComics)
      return items.length > 0 ? { items, metadata: undefined } : EndOfPageResults
    }

    if (!config) return EndOfPageResults
    const comics = this.sectionComics(config.id, allComics)

    if (comics.length === 0) return EndOfPageResults

    return {
      items: comics.map((comic) => this.toDiscoverItem(config, comic)),
      metadata: undefined,
    }
  }

  async getSearchResults(
    title: string,
    searchMetadata: Metadata | undefined
  ): Promise<PagedResults<SearchResultItem>> {
    const query = title.trim()
    const genre = this.searchGenre(searchMetadata)
    const comics = query
      ? (await this.getApi<PizzaReaderComicListResponse>(`/api/search/${encodeURIComponent(query)}`)).comics ?? []
      : await this.getComics()
    const filtered = genre
      ? comics.filter((comic) => (comic.genres ?? []).some((candidate) => candidate?.name === genre))
      : comics

    return {
      items: filtered.map((comic) => this.parser.toSearchResult(comic)),
      metadata: undefined,
    }
  }

  private async getComics(): Promise<PizzaReaderComic[]> {
    const result = await this.getApi<PizzaReaderComicListResponse>('/api/comics')
    return result.comics ?? []
  }

  private async getComic(mangaId: string): Promise<PizzaReaderComic> {
    const endpoint = `/api${this.normalizedPath(mangaId)}`
    const cached = this.cacheValue(this.mangaCache, endpoint)
    if (cached) return cached

    const result = await this.getApi<PizzaReaderComicResponse>(endpoint)
    if (!result.comic) throw new Error(`${this.config.sourceName} manga not found: ${mangaId}`)

    this.rememberCache(this.mangaCache, endpoint, result.comic, MANGA_CACHE_TTL_MS)
    return result.comic
  }

  private toDiscoverItem(
    config: PizzaReaderListingConfig,
    comic: PizzaReaderComic
  ): DiscoverSectionItem {
    const item = this.parser.toSearchResult(comic)

    if (config.id === 'featured') {
      return {
        type: 'featuredCarouselItem',
        mangaId: item.mangaId,
        imageUrl: item.imageUrl,
        title: item.title,
        supertitle: comic.last_chapter?.full_title || item.subtitle,
        contentRating: item.contentRating,
      }
    }

    if (config.includeChapterUpdates && comic.last_chapter?.url) {
      return {
        type: 'chapterUpdatesCarouselItem',
        mangaId: item.mangaId,
        chapterId: this.normalizedPath(comic.last_chapter.url),
        imageUrl: item.imageUrl,
        title: item.title,
        subtitle: comic.last_chapter.full_title || item.subtitle,
        publishDate: this.date(comic.last_chapter.published_on || comic.last_chapter.updated_at),
        contentRating: item.contentRating,
      }
    }

    return {
      type: config.id === 'popular' ? 'prominentCarouselItem' : 'simpleCarouselItem',
      mangaId: item.mangaId,
      imageUrl: item.imageUrl,
      title: item.title,
      subtitle: item.subtitle,
      contentRating: item.contentRating,
    }
  }

  private sectionComics(sectionId: string, comics: PizzaReaderComic[]): PizzaReaderComic[] {
    switch (sectionId) {
      case 'featured':
        return this.featuredComics(comics)
      case 'latest':
        return this.parser.sortLatest(comics).slice(0, 24)
      default:
        return comics.filter((comic) => this.imageForComic(comic))
    }
  }

  private sectionType(sectionId: string): DiscoverSectionType {
    if (sectionId === 'featured') return DiscoverSectionType.featured
    if (sectionId === 'latest') return DiscoverSectionType.chapterUpdates
    if (sectionId === 'popular') return DiscoverSectionType.prominentCarousel

    return DiscoverSectionType.simpleCarousel
  }

  private sectionSubtitle(sectionId: string): string {
    switch (sectionId) {
      case 'featured':
        return 'Serie aggiornate con copertina'
      case 'latest':
        return 'Capitoli pubblicati di recente'
      case 'popular':
        return 'Catalogo serie'
      default:
        return ''
    }
  }

  private imageForComic(comic: PizzaReaderComic): string {
    return comic.thumbnail || comic.thumbnail_small || ''
  }

  private featuredComics(comics: PizzaReaderComic[]): PizzaReaderComic[] {
    const recommended = comics
      .filter((comic) => Number(comic.recommended ?? 0) > 0 && this.imageForComic(comic))
      .sort((left, right) => Number(right.recommended ?? 0) - Number(left.recommended ?? 0))

    return (recommended.length >= 4 ? recommended : this.parser.sortLatest(comics).filter((comic) => this.imageForComic(comic))).slice(0, 8)
  }

  private genreItems(comics: PizzaReaderComic[]): DiscoverSectionItem[] {
    const counts = new Map<string, number>()

    for (const comic of comics) {
      for (const genre of comic.genres ?? []) {
        const name = genre?.name?.trim()
        if (!name || this.isAdultGenre(name)) continue

        counts.set(name, (counts.get(name) ?? 0) + 1)
      }
    }

    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, MAX_GENRES)
      .map(([genre]) => ({
        type: 'genresCarouselItem',
        name: genre,
        searchQuery: {
          title: '',
          metadata: {
            genre,
          },
        },
      }))
  }

  private async hasGenres(): Promise<boolean> {
    try {
      return this.genreItems(await this.getComics()).length > 0
    } catch {
      return false
    }
  }

  private searchGenre(metadata: Metadata | undefined): string {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return ''

    const genre = metadata.genre
    return typeof genre === 'string' ? genre : ''
  }

  private isAdultGenre(genre: string): boolean {
    return /hentai|adult|adulti|smut|yaoi|yuri|lolicon|shotacon/i.test(genre)
  }

  private async getApi<T>(endpoint: string, ttlMs = API_CACHE_TTL_MS): Promise<T> {
    const path = this.normalizedPath(endpoint)
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}${path}`
    const shouldCache = ttlMs > 0
    const cached = shouldCache ? this.cacheValue(this.apiCache, url) as T | undefined : undefined
    if (cached) return cached

    const pending = this.apiRequests.get(url) as Promise<T> | undefined
    if (pending) return pending

    const request = this.withRateLimit(async () => getJson<T>(url, await this.headers()))
      .then((result) => {
        if (shouldCache) this.rememberCache(this.apiCache, url, result, ttlMs)
        return result
      })
      .finally(() => {
        this.apiRequests.delete(url)
      })

    this.apiRequests.set(url, request)
    return request
  }

  private async withRateLimit<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.rateLimitQueue
    let release: () => void = () => {}

    this.rateLimitQueue = new Promise<void>((resolve) => {
      release = resolve
    })

    await previous

    try {
      await this.waitForRateLimit()
      return await operation()
    } finally {
      release()
    }
  }

  private async waitForRateLimit(): Promise<void> {
    const delayMs = this.config.requestDelayMs ?? 0
    if (delayMs <= 0) return

    const elapsed = Date.now() - this.lastRequestAt
    if (elapsed < delayMs) await this.sleep(delayMs - elapsed)

    this.lastRequestAt = Date.now()
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private async headers(): Promise<HeaderMap> {
    return mergeHeaders(await defaultBrowserHeaders(this.config.baseUrl), {
      accept: 'application/json,text/plain,*/*',
      'accept-language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      referer: this.config.baseUrl,
      'x-requested-with': 'XMLHttpRequest',
    })
  }

  private apiEndpoint(path: string): string {
    const normalized = this.normalizedPath(path)
    return normalized.startsWith('/api/') ? normalized : `/api${normalized}`
  }

  private withSubchapter(path: string, subchapter: string | undefined): string {
    const normalized = this.normalizedPath(path)
    if (/\/sub\/[^/]+\/?$/i.test(normalized)) return normalized
    if (!/\/ch\/[^/]+\/?$/i.test(normalized)) return normalized

    return `${normalized.replace(/\/+$/, '')}/sub/${subchapter || '0'}`
  }

  private chapterNumber(chapter: PizzaReaderChapter): number {
    const base = typeof chapter.chapter === 'number' ? chapter.chapter : 0
    const subchapter = typeof chapter.subchapter === 'number' ? chapter.subchapter : 0
    if (subchapter <= 0) return base

    return Number(`${base}.${subchapter}`)
  }

  private normalizedPath(value: string): string {
    const clean = value.trim()
    if (!clean) return '/'

    const base = this.config.baseUrl.replace(/\/+$/, '')
    if (clean.startsWith(base)) return clean.slice(base.length) || '/'

    return clean.startsWith('/') ? clean : `/${clean}`
  }

  private date(value: string | undefined): Date | undefined {
    if (!value) return undefined

    const normalized = value.replace(/\.(\d{3})\d+(Z|[+-]\d\d:\d\d)$/i, '.$1$2')
    const time = Date.parse(normalized)
    return Number.isFinite(time) ? new Date(time) : undefined
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
