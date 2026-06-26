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

import { IMAGE_ACCEPT_HEADER, MOBILE_SAFARI_USER_AGENT, type HeaderMap } from '../common/http/headers'
import { proxiedReaderImageUrls } from '../common/utils/images'
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
const HTML_CACHE_TTL_MS = 5 * 60 * 1000
const COMIC_DATA_CACHE_TTL_MS = 10 * 60 * 1000
const IMAGE_PROBE_CACHE_TTL_MS = 15 * 60 * 1000
const MAX_CACHE_ENTRIES = 30
const MAX_COVER_ENRICHMENT_ITEMS = 16
const COVER_ENRICHMENT_BATCH_SIZE = 4
const MAX_IMAGE_PROBES_PER_CANDIDATE = 80
const IMAGE_PROBE_BATCH_SIZE = 8

interface CacheEntry<T> {
  expiresAt: number
  value: T
}

const SECTIONS: RCOStationListingConfig[] = [
  {
    id: 'featured',
    title: 'Featured Comics',
    heading: 'New comic',
    includeChapterUpdates: false,
  },
  {
    id: 'latest',
    title: 'Latest Issues',
    heading: 'Latest update',
    includeChapterUpdates: true,
  },
  {
    id: 'new',
    title: 'New Comics',
    heading: 'New comic',
    includeChapterUpdates: false,
  },
  {
    id: 'popular',
    title: 'Popular Comics',
    heading: 'Most popular',
    includeChapterUpdates: false,
  },
]

export class RCOStationClient {
  private readonly parser = new RCOStationParser(BASE_URL)
  private readonly htmlCache = new Map<string, CacheEntry<TextResponse>>()
  private readonly htmlRequests = new Map<string, Promise<TextResponse>>()
  private readonly comicDataCache = new Map<string, CacheEntry<RCOStationComicData>>()
  private readonly imageProbeCache = new Map<string, CacheEntry<boolean>>()

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

    debugLog(`[RCOStation] Reader images returned: ${pages.length}`)
    if (pages.length === 0) throw new Error('No readable pages were found for this issue.')

    return {
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      pages: proxiedReaderImageUrls(pages),
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

  async getDiscoverSectionItems(section: DiscoverSection): Promise<PagedResults<DiscoverSectionItem>> {
    const config = SECTIONS.find((candidate) => candidate.id === section.id)
    if (!config) return EndOfPageResults

    const response = await this.getHtml(BASE_URL)
    const parsedItems = this.parser.parseHomepageSection(response.body, config.heading, response.url)
    const items = await this.withUsableImages(parsedItems, config.id === 'latest')
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
      const latest = await this.withUsableImages(
        this.parser.parseHomepageSection(response.body, SECTIONS[0].heading, response.url),
        true
      )

      return {
        items: latest.map((item) => this.parser.toSearchResult(item)),
        metadata: undefined,
      }
    }

    const response = await this.postSearch(query)
    const items = await this.withUsableImages(
      this.parser.parseSearchResults(response.body, response.url),
      true
    )

    return {
      items: items.map((item) => this.parser.toSearchResult(item)),
      metadata: undefined,
    }
  }

  private async withUsableImages(
    items: RCOStationListingItem[],
    enrichMissingImages: boolean
  ): Promise<RCOStationListingItem[]> {
    const byMangaId = new Map<string, RCOStationListingItem>()
    const pendingEnrichment: RCOStationListingItem[] = []

    for (const item of items) {
      if (this.isUsableImageUrl(item.imageUrl)) {
        byMangaId.set(item.mangaId, item)
        continue
      }

      if (enrichMissingImages && pendingEnrichment.length < MAX_COVER_ENRICHMENT_ITEMS) {
        pendingEnrichment.push(item)
      }
    }

    for (let index = 0; index < pendingEnrichment.length; index += COVER_ENRICHMENT_BATCH_SIZE) {
      const batch = pendingEnrichment.slice(index, index + COVER_ENRICHMENT_BATCH_SIZE)
      const enriched = await Promise.all(
        batch.map(async (item) => {
          const imageUrl = await this.coverForManga(item.mangaId)
          return this.isUsableImageUrl(imageUrl) ? { ...item, imageUrl } : undefined
        })
      )

      for (const item of enriched) {
        if (item) byMangaId.set(item.mangaId, item)
      }
    }

    return items
      .map((item) => byMangaId.get(item.mangaId))
      .filter((item): item is RCOStationListingItem => Boolean(item))
  }

  private async coverForManga(mangaId: string): Promise<string> {
    try {
      return (await this.getComicData(mangaId)).imageUrl
    } catch (error) {
      debugLog(`[RCOStation] Could not load cover for ${mangaId}: ${String(error)}`)
      return ''
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
    let bestPages: string[] = []

    for (const candidate of candidates) {
      if (!candidate || attempted.has(candidate)) continue

      attempted.add(candidate)

      try {
        const response = await this.getHtml(candidate)
        const pages = this.parser.parseReaderPages(response.body, response.url)
        if (pages.length === 0) continue

        const validPages = await this.filterValidReaderImages(pages)
        debugLog(
          `[RCOStation] Reader candidate ${candidate} parsed=${pages.length} valid=${validPages.length}`
        )

        if (validPages.length > bestPages.length) bestPages = validPages
        if (validPages.length === pages.length) return validPages
      } catch (error) {
        debugLog(`[RCOStation] Reader candidate failed ${candidate}: ${String(error)}`)
      }
    }

    return bestPages
  }

  private async filterValidReaderImages(pages: string[]): Promise<string[]> {
    const validPages: string[] = []
    const limitedPages = pages.slice(0, MAX_IMAGE_PROBES_PER_CANDIDATE)

    for (let index = 0; index < limitedPages.length; index += IMAGE_PROBE_BATCH_SIZE) {
      const batch = limitedPages.slice(index, index + IMAGE_PROBE_BATCH_SIZE)
      const workingUrls = await Promise.all(
        batch.map((page) => this.firstWorkingImageUrl(page))
      )

      for (const workingUrl of workingUrls) {
        if (workingUrl) validPages.push(workingUrl)
      }
    }

    return validPages
  }

  private async firstWorkingImageUrl(imageUrl: string): Promise<string> {
    for (const candidate of this.readerImageUrlCandidates(imageUrl)) {
      if (await this.isImageResponse(candidate)) return candidate
    }

    return ''
  }

  private readerImageUrlCandidates(imageUrl: string): string[] {
    const candidates = [imageUrl]

    for (const replacement of this.blogspotSizeFallbacks(imageUrl)) {
      if (!candidates.includes(replacement)) candidates.push(replacement)
    }

    return candidates
  }

  private blogspotSizeFallbacks(imageUrl: string): string[] {
    const fallbacks: string[] = []

    if (/=s1600(?=[?#]|$)/i.test(imageUrl)) {
      fallbacks.push(imageUrl.replace(/=s1600(?=[?#]|$)/i, '=s0'))
    }

    if (/=s0(?=[?#]|$)/i.test(imageUrl)) {
      fallbacks.push(imageUrl.replace(/=s0(?=[?#]|$)/i, '=s1600'))
    }

    if (/\/s1600\//i.test(imageUrl)) {
      fallbacks.push(imageUrl.replace(/\/s1600\//i, '/s0/'))
    }

    if (/\/s0\//i.test(imageUrl)) {
      fallbacks.push(imageUrl.replace(/\/s0\//i, '/s1600/'))
    }

    return fallbacks
  }

  private async isImageResponse(imageUrl: string): Promise<boolean> {
    const cached = this.cacheValue(this.imageProbeCache, imageUrl)
    if (cached !== undefined) return cached

    try {
      const [response] = await Application.scheduleRequest({
        url: imageUrl,
        method: 'GET',
        headers: this.imageProbeHeaders(),
      })
      const contentType = this.headerValue(response.headers, 'content-type').toLowerCase()
      const ok = response.status >= 200 && response.status < 300 && contentType.startsWith('image/')

      this.rememberCache(this.imageProbeCache, imageUrl, ok, IMAGE_PROBE_CACHE_TTL_MS)
      return ok
    } catch (error) {
      debugLog(`[RCOStation] Image probe failed ${imageUrl}: ${String(error)}`)
      this.rememberCache(this.imageProbeCache, imageUrl, false, IMAGE_PROBE_CACHE_TTL_MS)
      return false
    }
  }

  private imageProbeHeaders(): HeaderMap {
    return {
      'user-agent': MOBILE_SAFARI_USER_AGENT,
      accept: IMAGE_ACCEPT_HEADER,
      'accept-language': 'en-US,en;q=0.9',
      referer: BASE_URL,
      range: 'bytes=0-0',
    }
  }

  private toDiscoverItem(
    config: RCOStationListingConfig,
    item: RCOStationListingItem
  ): DiscoverSectionItem {
    if (config.id === 'featured') {
      return {
        type: 'featuredCarouselItem',
        mangaId: item.mangaId,
        imageUrl: item.imageUrl,
        title: item.title,
        supertitle: item.subtitle,
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

  private sectionType(sectionId: string): DiscoverSectionType {
    if (sectionId === 'featured') return DiscoverSectionType.featured
    if (sectionId === 'latest') return DiscoverSectionType.chapterUpdates

    return DiscoverSectionType.prominentCarousel
  }

  private sectionSubtitle(sectionId: string): string {
    switch (sectionId) {
      case 'featured':
        return 'Fresh homepage picks with cover art'
      case 'latest':
        return 'Fresh issue releases'
      case 'new':
        return 'Newly added comic series'
      case 'popular':
        return 'Most-read comics'
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
      'user-agent': MOBILE_SAFARI_USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      referer,
    }
  }

  private comicUrl(mangaId: string): string {
    return normalizeUrl(mangaId, BASE_URL)
  }

  private isUsableImageUrl(imageUrl: string | undefined): boolean {
    return /^https?:\/\//i.test(imageUrl ?? '')
  }

  private headerValue(headers: Record<string, string>, name: string): string {
    const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())
    return match?.[1] ?? ''
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
