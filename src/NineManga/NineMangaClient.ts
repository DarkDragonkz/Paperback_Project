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
import { getText, type TextResponse } from './NineMangaHttp'
import type {
  NineMangaChapterPage,
  NineMangaGenre,
  NineMangaListingConfig,
  NineMangaListingItem,
  NineMangaMangaData,
  NineMangaPageMetadata,
  NineMangaSearchMetadata,
  NineMangaSectionId,
} from './NineMangaModels'
import { NineMangaParser } from './NineMangaParser'

const BASE_URL = 'https://www.ninemanga.com/'
const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const HTML_CACHE_TTL_MS = 5 * 60 * 1000
const MANGA_DATA_CACHE_TTL_MS = 10 * 60 * 1000
const MAX_CACHE_ENTRIES = 30
const MAX_READER_REDIRECTS = 6

interface CacheEntry<T> {
  expiresAt: number
  value: T
}

const SECTIONS: NineMangaListingConfig[] = [
  {
    id: 'featured',
    title: 'Featured Manga',
    path: '/category/index_1.html',
    includeChapterUpdates: false,
  },
  {
    id: 'latest',
    title: 'Latest Updates',
    path: '/list/New-Update/',
    includeChapterUpdates: true,
  },
  {
    id: 'popular',
    title: 'Popular Manga',
    path: '/category/index_1.html',
    includeChapterUpdates: false,
  },
]

const GENRES: NineMangaGenre[] = [
  { id: 'action', title: 'Action', path: '/category/Action_1.html' },
  { id: 'adventure', title: 'Adventure', path: '/category/Adventure_1.html' },
  { id: 'comedy', title: 'Comedy', path: '/category/Comedy_1.html' },
  { id: 'drama', title: 'Drama', path: '/category/Drama_1.html' },
  { id: 'fantasy', title: 'Fantasy', path: '/category/Fantasy_1.html' },
  { id: 'romance', title: 'Romance', path: '/category/Romance_1.html' },
  { id: 'shoujo', title: 'Shoujo', path: '/category/Shoujo_1.html' },
  { id: 'shounen', title: 'Shounen', path: '/category/Shounen_1.html' },
  { id: 'slice-of-life', title: 'Slice of Life', path: '/category/Slice-of-Life_1.html' },
  { id: 'supernatural', title: 'Supernatural', path: '/category/Supernatural_1.html' },
]

export class NineMangaClient {
  private readonly parser = new NineMangaParser(BASE_URL)
  private readonly htmlCache = new Map<string, CacheEntry<TextResponse>>()
  private readonly htmlRequests = new Map<string, Promise<TextResponse>>()
  private readonly mangaDataCache = new Map<string, CacheEntry<NineMangaMangaData>>()

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    return this.parser.toSourceManga(await this.getMangaData(mangaId))
  }

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const details = await this.getMangaData(sourceManga.mangaId)
    return details.chapters.map((chapter) => ({
      ...chapter,
      sourceManga,
    }))
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const chapterUrl = normalizeUrl(chapter.additionalInfo?.url ?? chapter.chapterId, BASE_URL)
    const pageRefs = await this.resolveChapterPageRefs(chapterUrl, BASE_URL, 0, new Set<string>())
    const pages: string[] = []

    for (const pageRef of pageRefs) {
      if (pageRef.imageUrl) {
        pages.push(pageRef.imageUrl)
        continue
      }

      const pageHtml = await this.getHtml(pageRef.url, chapterUrl)
      const imageUrl = this.parser.parseImage(pageHtml.body)
      if (imageUrl) pages.push(imageUrl)
    }

    const uniquePages = [...new Set(pages.filter(Boolean))]
    console.log(`[NineManga] Reader images returned: ${uniquePages.length}`)
    if (uniquePages.length === 0) throw new Error('No readable pages found for this NineManga chapter')

    return {
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      pages: uniquePages,
    }
  }

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      ...SECTIONS.map((section) => ({
        id: section.id,
        title: section.title,
        subtitle: this.sectionSubtitle(section.id),
        type: this.sectionType(section.id),
      })),
      {
        id: 'genres',
        title: 'Browse by Genre',
        subtitle: 'Quick access to NineManga categories',
        type: DiscoverSectionType.genres,
      },
    ]
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: Metadata | undefined
  ): Promise<PagedResults<DiscoverSectionItem>> {
    if (section.id === 'genres') {
      return {
        items: GENRES.map((genre) => ({
          type: 'genresCarouselItem',
          name: genre.title,
          searchQuery: {
            title: '',
            metadata: {
              genrePath: genre.path,
              genreTitle: genre.title,
            } satisfies NineMangaSearchMetadata,
          },
        })),
        metadata: undefined,
      }
    }

    const config = SECTIONS.find((candidate) => candidate.id === section.id)
    if (!config) return EndOfPageResults

    const url = this.readNextUrl(metadata) || normalizeUrl(config.path, BASE_URL)
    const response = await this.getHtml(url)
    const page = this.parser.parseListingPage(response.body, response.url)
    console.log(`[NineManga] Discover section ${section.id} returned: ${page.items.length}`)
    if (page.items.length === 0) return EndOfPageResults

    return {
      items: page.items.map((item) => this.toDiscoverItem(config, item)),
      metadata: page.nextUrl ? { nextUrl: page.nextUrl } satisfies NineMangaPageMetadata : undefined,
    }
  }

  async getSearchResults(
    title: string,
    queryMetadata: Metadata | undefined,
    pageMetadata: Metadata | undefined
  ): Promise<PagedResults<SearchResultItem>> {
    const query = title.trim()
    const searchMetadata = queryMetadata as NineMangaSearchMetadata | undefined
    const nextUrl = this.readNextUrl(pageMetadata)
    const url = nextUrl || this.searchUrl(query, searchMetadata)
    const response = await this.getHtml(url)
    const page = this.parser.parseListingPage(response.body, response.url)

    console.log(`[NineManga] Search/listing results returned: ${page.items.length}`)

    return {
      items: page.items.map((item) => this.parser.toSearchResult(item)),
      metadata: page.nextUrl ? { nextUrl: page.nextUrl } satisfies NineMangaPageMetadata : undefined,
    }
  }

  private searchUrl(query: string, metadata: NineMangaSearchMetadata | undefined): string {
    if (query) return `${normalizeUrl('/search/', BASE_URL)}?wd=${encodeURIComponent(query)}&page=1&type=high`

    if (metadata?.genrePath) return normalizeUrl(metadata.genrePath, BASE_URL)

    return normalizeUrl(SECTIONS[0].path, BASE_URL)
  }

  private async getMangaData(mangaId: string): Promise<NineMangaMangaData> {
    const mangaUrl = this.withWarning(normalizeUrl(mangaId, BASE_URL))
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

  private async resolveChapterPageRefs(
    url: string,
    referer: string,
    depth: number,
    visited: Set<string>
  ): Promise<NineMangaChapterPage[]> {
    const normalizedUrl = normalizeUrl(url, BASE_URL)
    if (!normalizedUrl || visited.has(normalizedUrl)) return []
    if (depth > MAX_READER_REDIRECTS) throw new Error('NineManga reader redirect limit reached')
    visited.add(normalizedUrl)

    const response = await this.getHtml(normalizedUrl, referer)
    const result = this.parser.parseChapterPageResult(response.body, response.url)
    if (result.pages.length > 0) return result.pages

    if (result.nextUrl) {
      return this.resolveChapterPageRefs(result.nextUrl, response.url, depth + 1, visited)
    }

    return []
  }

  private toDiscoverItem(
    config: NineMangaListingConfig,
    item: NineMangaListingItem
  ): DiscoverSectionItem {
    const contentRating = this.parser.contentRatingForGenres(item.genres)

    if (config.id === 'featured') {
      return {
        type: 'featuredCarouselItem',
        mangaId: item.mangaId,
        imageUrl: item.imageUrl,
        title: item.title,
        supertitle: item.latestChapterTitle,
        contentRating,
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
        contentRating,
      }
    }

    return {
      type: 'simpleCarouselItem',
      mangaId: item.mangaId,
      imageUrl: item.imageUrl,
      title: item.title,
      subtitle: item.genres.join(', ') || item.latestChapterTitle,
      contentRating: contentRating || ContentRating.EVERYONE,
    }
  }

  private sectionType(sectionId: string): DiscoverSectionType {
    if (sectionId === 'featured') return DiscoverSectionType.featured
    if (sectionId === 'latest') return DiscoverSectionType.chapterUpdates
    if (sectionId === 'genres') return DiscoverSectionType.genres

    return DiscoverSectionType.prominentCarousel
  }

  private sectionSubtitle(sectionId: string): string {
    switch (sectionId) {
      case 'featured':
        return 'Popular catalog picks'
      case 'latest':
        return 'Latest chapter updates'
      case 'popular':
        return 'Browse the main catalog'
      case 'genres':
        return 'Quick access to categories'
      default:
        return ''
    }
  }

  private async getHtml(url: string, referer = BASE_URL): Promise<TextResponse> {
    const normalizedUrl = normalizeUrl(url, BASE_URL)
    const cachedResponse = this.cacheValue(this.htmlCache, normalizedUrl)
    if (cachedResponse) return cachedResponse

    const pendingRequest = this.htmlRequests.get(normalizedUrl)
    if (pendingRequest) return pendingRequest

    if (!normalizedUrl) throw new Error('NineManga request failed: invalid URL')

    const request = getText(normalizedUrl, this.headers(normalizedUrl, referer))
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

  private headers(targetUrl: string, referer = BASE_URL): HeaderMap {
    const headers: HeaderMap = {
      'user-agent': MOBILE_USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      referer,
    }

    if (/^https:\/\/(?:www\.|it\.|es\.|br\.|fr\.|de\.|ru\.)?ninemanga\.com\//i.test(targetUrl)) {
      headers.cookie = 'ninemanga_list_num=1'
    }

    return headers
  }

  private withWarning(url: string): string {
    if (!url || !url.includes('/manga/')) return url
    if (/[?&]waring=1(?:&|$)/i.test(url)) return url

    return withQueryParam(url, BASE_URL, 'waring', '1')
  }

  private readNextUrl(metadata: Metadata | undefined): string {
    const nextUrl = (metadata as NineMangaPageMetadata | undefined)?.nextUrl
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

export function isNineMangaSectionId(value: string): value is NineMangaSectionId {
  return value === 'genres' || SECTIONS.some((section) => section.id === value)
}
