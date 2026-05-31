import {
  ContentRating,
  DiscoverSectionType,
  EndOfPageResults,
  type Chapter,
  type ChapterDetails,
  type Cookie,
  type DiscoverSection,
  type DiscoverSectionItem,
  type Metadata,
  type PagedResults,
  type SearchResultItem,
  type SourceManga,
} from '@paperback/types'

import { defaultBrowserHeaders, mergeHeaders } from '../common/http/headers'
import { CloudflareBypassInProgressError, getJson, getText, type TextResponse } from '../common/http/request'
import type { PageMetadata } from '../common/models/Pagination'
import { uniqueStrings } from '../common/utils/array'
import { normalizeUrl, pathIdFromUrl, withQueryParam } from '../common/utils/url'
import type {
  NineMangaListingConfig,
  NineMangaListingItem,
  NineMangaMobileSearchItem,
  NineMangaMangaData,
  NineMangaSectionId,
} from './NineMangaModels'
import { NineMangaParser, type NineMangaReaderPageKind } from './NineMangaParser'

const BASE_URL = 'https://www.ninemanga.com/'
const HTML_CACHE_TTL_MS = 2 * 60 * 1000
const MANGA_DATA_CACHE_TTL_MS = 5 * 60 * 1000
const MAX_CACHE_ENTRIES = 30
const MAX_READER_REQUESTS = 40

interface CacheEntry<T> {
  expiresAt: number
  value: T
}

interface ReaderResolutionState {
  visitedUrls: Set<string>
  gateUrls: string[]
  requestCount: number
}

const SECTIONS: NineMangaListingConfig[] = [
  {
    id: 'latest',
    title: 'Latest Updates',
    path: '/list/New-Update/',
    ajaxPrefix: '/ajax/lastest/page-',
    includeChapterUpdates: true,
  },
  {
    id: 'hot',
    title: 'Hot Manga',
    path: '/list/Hot-Book/',
    ajaxPrefix: '/ajax/hot_manga/page-',
    includeChapterUpdates: false,
  },
  {
    id: 'new',
    title: 'New Manga',
    path: '/list/New-Book/',
    ajaxPrefix: '/ajax/new_manga/page-',
    includeChapterUpdates: false,
  },
  {
    id: 'completed',
    title: 'Completed',
    path: '/category/completed.html',
    ajaxPrefix: '/ajax/category/category-completed-page-',
    includeChapterUpdates: false,
  },
  {
    id: 'updated',
    title: 'Updated Directory',
    path: '/category/updated.html',
    ajaxPrefix: '/ajax/category/category-updated-page-',
    includeChapterUpdates: false,
  },
]

export class NineMangaClient {
  private readonly parser = new NineMangaParser(BASE_URL)
  private readonly htmlCache = new Map<string, CacheEntry<TextResponse>>()
  private readonly htmlRequests = new Map<string, Promise<TextResponse>>()
  private readonly mangaDataCache = new Map<string, CacheEntry<NineMangaMangaData>>()

  constructor(private readonly setCookie?: (cookie: Cookie) => void) {}

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const details = await this.getMangaData(mangaId)
    return this.parser.toSourceManga(details)
  }

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const details = await this.getMangaData(sourceManga.mangaId)
    return details.chapters.map((chapter) => ({
      ...chapter,
      sourceManga,
    }))
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const preparedChapter = await this.prepareReaderChapter(chapter)
    this.setReaderUnlockCookie(preparedChapter)
    this.setReaderListCookie()

    const rawChapterUrl = this.resolveReaderChapterUrl(preparedChapter)
    const chapterUrl = this.withReaderWarning(rawChapterUrl)
    if (!chapterUrl) throw new Error('Invalid NineManga chapter URL')

    const pages = await this.resolveReaderImages(preparedChapter, chapterUrl)

    const uniquePages = uniqueStrings(pages)
    console.log(`[NineManga] Reader images returned: ${uniquePages.length}`)
    if (uniquePages.length === 0) {
      throw new Error('NineManga reader: no readable images found. Page may require WebView/Cloudflare session.')
    }

    return {
      id: preparedChapter.chapterId,
      mangaId: preparedChapter.sourceManga.mangaId,
      pages: uniquePages,
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
    const config = SECTIONS.find((candidate) => candidate.id === section.id)
    if (!config) return EndOfPageResults

    const page = this.readPage(metadata)
    const items = await this.getDiscoverListing(config, page)
    if (items.length === 0) return EndOfPageResults

    return {
      items: items.map((item) => this.toDiscoverItem(config, item)),
      metadata: { page: page + 1 } satisfies PageMetadata,
    }
  }

  async getSearchResults(title: string): Promise<PagedResults<SearchResultItem>> {
    const query = title.trim()
    if (!query) {
      const latest = await this.getListing(SECTIONS[0], 1)
      return {
        items: latest.map((item) => ({
          mangaId: item.mangaId,
          title: item.title,
          subtitle: item.latestChapterTitle,
          imageUrl: item.imageUrl,
          contentRating: this.contentRatingForGenres(item.genres),
        })),
        metadata: undefined,
      }
    }

    const url = withQueryParam('/search/mobile/', BASE_URL, 'wd', query)

    const items = await getJson<NineMangaMobileSearchItem[]>(
      url,
      await this.getHeaders()
    )

    return {
      items: this.parser.parseMobileSearch(items),
      metadata: undefined,
    }
  }

  private async getMangaData(mangaId: string): Promise<NineMangaMangaData> {
    const mangaUrl = this.withMangaWarning(normalizeUrl(mangaId, BASE_URL), true)
    const cachedData = this.cacheValue(this.mangaDataCache, mangaUrl)
    if (cachedData) return cachedData

    const firstResponse = await this.getHtml(mangaUrl)
    const firstData = this.parser.parseManga(
      firstResponse.body,
      pathIdFromUrl(firstResponse.url, BASE_URL),
      firstResponse.url
    )

    if (firstData.warningUrl && firstData.chapters.length === 0) {
      const warningResponse = await this.getHtml(firstData.warningUrl)
      const warningData = this.parser.parseManga(
        warningResponse.body,
        pathIdFromUrl(mangaUrl, BASE_URL),
        warningResponse.url
      )

      if (warningData.chapters.length > 0) {
        this.rememberCache(this.mangaDataCache, mangaUrl, warningData, MANGA_DATA_CACHE_TTL_MS)
        return warningData
      }
    }

    if (firstData.chapters.length === 0 && firstData.warningUrl) {
      const fallbackUrl = withQueryParam(mangaUrl, BASE_URL, 'waring', '1')
      const fallbackResponse = await this.getHtml(fallbackUrl)
      const fallbackData = this.parser.parseManga(
        fallbackResponse.body,
        pathIdFromUrl(mangaUrl, BASE_URL),
        fallbackResponse.url
      )

      this.rememberCache(this.mangaDataCache, mangaUrl, fallbackData, MANGA_DATA_CACHE_TTL_MS)
      return fallbackData
    }

    this.rememberCache(this.mangaDataCache, mangaUrl, firstData, MANGA_DATA_CACHE_TTL_MS)
    return firstData
  }

  private async getListing(config: NineMangaListingConfig, page: number): Promise<NineMangaListingItem[]> {
    const path = page === 1 ? config.path : `${config.ajaxPrefix}${page}`
    const response = await this.getHtml(normalizeUrl(path, BASE_URL))
    return this.parser.parseListing(response.body)
  }

  private async getDiscoverListing(
    config: NineMangaListingConfig,
    page: number
  ): Promise<NineMangaListingItem[]> {
    try {
      return await this.getListing(config, page)
    } catch (error) {
      if (error instanceof CloudflareBypassInProgressError) {
        console.log(`[NineManga] Skipping ${config.id}; Cloudflare bypass is already pending`)
        return []
      }

      throw error
    }
  }

  private toDiscoverItem(
    config: NineMangaListingConfig,
    item: NineMangaListingItem
  ): DiscoverSectionItem {
    if (config.id === 'hot') {
      return {
        type: 'featuredCarouselItem',
        mangaId: item.mangaId,
        imageUrl: item.imageUrl,
        title: item.title,
        supertitle: item.genres.join(', ') || item.latestChapterTitle,
        contentRating: this.contentRatingForGenres(item.genres),
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
        contentRating: this.contentRatingForGenres(item.genres),
      }
    }

    return {
      type: 'prominentCarouselItem',
      mangaId: item.mangaId,
      imageUrl: item.imageUrl,
      title: item.title,
      subtitle: item.genres.join(', ') || item.latestChapterTitle,
      contentRating: this.contentRatingForGenres(item.genres),
    }
  }

  private async resolveReaderImages(chapter: Chapter, chapterUrl: string): Promise<string[]> {
    const state: ReaderResolutionState = {
      visitedUrls: new Set<string>(),
      gateUrls: [],
      requestCount: 0,
    }
    const candidates = this.readerDirectCandidates(chapter, chapterUrl)
    this.rememberGateUrl(chapterUrl, state)

    console.log(`[NineManga] Reader direct candidates: ${candidates.length}`)

    for (const candidate of candidates) {
      const pages = await this.resolveNineMangaReaderCandidate(candidate, state)
      if (pages.length > 0) return pages
    }

    for (const gateUrl of uniqueStrings(state.gateUrls)) {
      const pages = await this.resolveReaderGateFallback(gateUrl, state)
      if (pages.length > 0) return pages
    }

    return []
  }

  private async resolveNineMangaReaderCandidate(
    url: string,
    state: ReaderResolutionState
  ): Promise<string[]> {
    const response = await this.getReaderHtml(url, BASE_URL, state)
    if (!response) return []

    return this.resolveReaderResponse(response, state)
  }

  private async resolveReaderResponse(
    response: TextResponse,
    state: ReaderResolutionState
  ): Promise<string[]> {
    const classification = this.parser.classifyReaderPage(response.body, response.url)
    this.logReaderClassification(response.url, classification)

    if (classification === 'source-gate') {
      this.rememberGateUrl(this.parser.parseSourceSelectionUrl(response.body), state)
      return []
    }

    if (classification === 'external-ad') {
      this.rememberGateUrl(response.url, state)
      return []
    }

    if (classification === 'cloudflare' || classification === 'dead') return []

    const directImages = this.parser.parseReaderImageUrls(response.body, response.url)
    const hasInlineImageList = response.body.toLowerCase().includes('all_imgs_url')
    if (hasInlineImageList && directImages.length > 0) return directImages

    const pageUrls = this.parser.parseReaderPageUrls(response.body, response.url)
    if (pageUrls.length === 0 || directImages.length > 1) return directImages

    const pages: string[] = [...directImages]
    for (const pageUrl of pageUrls) {
      if (!this.isNineMangaUrl(pageUrl)) {
        this.rememberGateUrl(pageUrl, state)
        continue
      }

      const pageResponse = await this.getReaderHtml(pageUrl, response.url, state)
      if (!pageResponse) continue

      const pageClassification = this.parser.classifyReaderPage(pageResponse.body, pageResponse.url)
      this.logReaderClassification(pageResponse.url, pageClassification)

      if (pageClassification === 'source-gate') {
        this.rememberGateUrl(this.parser.parseSourceSelectionUrl(pageResponse.body), state)
        continue
      }

      if (pageClassification !== 'real-reader') continue

      pages.push(...this.parser.parseReaderImageUrls(pageResponse.body, pageResponse.url))
    }

    return uniqueStrings(pages)
  }

  private async resolveReaderGateFallback(
    gateUrl: string,
    state: ReaderResolutionState
  ): Promise<string[]> {
    const response = await this.getReaderHtml(gateUrl, BASE_URL, state)
    if (!response) return []

    const directImages = this.parser.parseReaderImageUrls(response.body, response.url)
    if (directImages.length > 0) return directImages

    const redirectUrl = this.parser.parseReaderRedirectUrl(response.body, response.url)
    const sourceUrl = this.parser.parseSourceSelectionUrl(response.body)
    const nextUrls = uniqueStrings([redirectUrl, sourceUrl].filter(Boolean) as string[])

    for (const nextUrl of nextUrls) {
      if (this.isNineMangaUrl(nextUrl)) {
        const pages = await this.resolveNineMangaReaderCandidate(this.withReaderWarning(nextUrl), state)
        if (pages.length > 0) return pages
        continue
      }

      if (this.isKnownGateUrl(nextUrl)) {
        const pages = await this.resolveReaderGateFallback(nextUrl, state)
        if (pages.length > 0) return pages
      }
    }

    return []
  }

  private async getReaderHtml(
    url: string,
    referer: string,
    state: ReaderResolutionState
  ): Promise<TextResponse | undefined> {
    const normalizedUrl = this.isNineMangaUrl(url)
      ? this.withReaderWarning(normalizeUrl(url, BASE_URL))
      : normalizeUrl(url, BASE_URL)
    const key = this.sourceFlowKey(normalizedUrl)

    if (!normalizedUrl || state.visitedUrls.has(key)) return undefined

    if (state.requestCount >= MAX_READER_REQUESTS) {
      console.log(`[NineManga] Reader request limit reached at ${MAX_READER_REQUESTS}`)
      return undefined
    }

    state.visitedUrls.add(key)
    state.requestCount += 1

    const response = await getText(normalizedUrl, await this.getReaderHeaders(referer))
    if (!this.isNineMangaUrl(response.url) && this.isKnownGateUrl(response.url)) {
      this.rememberGateUrl(response.url, state)
    }

    return response
  }

  private readerDirectCandidates(chapter: Chapter, chapterUrl: string): string[] {
    const candidates: string[] = []
    const normalizedChapterUrl = normalizeUrl(chapterUrl, BASE_URL)

    if (this.isNineMangaUrl(normalizedChapterUrl)) {
      candidates.push(this.withReaderWarning(normalizedChapterUrl))
    }

    const canonicalUrl = this.canonicalNineMangaChapterUrl(chapter)
    const readerBases = uniqueStrings([canonicalUrl, normalizedChapterUrl].filter((url) => this.isNineMangaUrl(url)))

    for (const readerBase of readerBases) {
      const base = this.readerBaseUrl(readerBase)
      const stem = base.endsWith('.html')
        ? base.replace(/\.html$/i, '')
        : base.replace(/\/$/i, '')

      candidates.push(this.withReaderWarning(`${stem}-10-1.html`))
      candidates.push(this.withReaderWarning(`${stem}-6-1.html`))
      candidates.push(this.withReaderWarning(`${stem}-3-1.html`))
      candidates.push(this.withReaderWarning(`${stem}-1-1.html`))
      candidates.push(this.withReaderWarning(`${stem}.html`))
      candidates.push(this.withReaderWarning(`${stem}/`))
    }

    return uniqueStrings(candidates.filter(Boolean))
  }

  private rememberGateUrl(url: string | undefined, state: ReaderResolutionState): void {
    if (!url) return

    const normalizedUrl = normalizeUrl(url, BASE_URL)
    if (!normalizedUrl || this.isNineMangaUrl(normalizedUrl)) return
    if (!this.isKnownGateUrl(normalizedUrl)) return

    state.gateUrls.push(normalizedUrl)
  }

  private logReaderClassification(url: string, classification: NineMangaReaderPageKind): void {
    if (classification === 'real-reader') return

    console.log(`[NineManga] Reader classified ${classification}: ${url}`)
  }

  private sectionType(sectionId: string): DiscoverSectionType {
    if (sectionId === 'latest') return DiscoverSectionType.chapterUpdates
    if (sectionId === 'hot') return DiscoverSectionType.featured

    return DiscoverSectionType.prominentCarousel
  }

  private sectionSubtitle(sectionId: string): string {
    switch (sectionId) {
      case 'latest':
        return 'Fresh chapter releases'
      case 'hot':
        return 'Popular manga on NineManga'
      case 'new':
        return 'Newly added series'
      case 'completed':
        return 'Completed series'
      case 'updated':
        return 'Recently updated directory'
      default:
        return ''
    }
  }

  private contentRatingForGenres(genres: string[]): ContentRating {
    const normalized = genres.map((genre) => genre.toLowerCase())
    if (normalized.some((genre) => ['adult', 'hentai', 'smut'].includes(genre))) {
      return ContentRating.ADULT
    }

    if (normalized.some((genre) => ['mature', 'ecchi'].includes(genre))) {
      return ContentRating.MATURE
    }

    return ContentRating.EVERYONE
  }

  private async getHtml(url: string, referer = BASE_URL) {
    const normalizedUrl = normalizeUrl(url, BASE_URL)
    const cachedResponse = this.cacheValue(this.htmlCache, normalizedUrl)
    if (cachedResponse) return cachedResponse

    const pendingRequest = this.htmlRequests.get(normalizedUrl)
    if (pendingRequest) return pendingRequest

    const request = getText(normalizedUrl, await this.getHeaders(referer))
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

  private withMangaWarning(url: string, force = false): string {
    if (!url || (!force && !this.isMangaUrl(url))) return url

    return withQueryParam(url, BASE_URL, 'waring', '1')
  }

  private withReaderWarning(url: string): string {
    if (!url || !this.isNineMangaUrl(url) || !url.includes('/chapter/')) return url

    return withQueryParam(url, BASE_URL, 'waring', '1')
  }

  private isMangaUrl(url: string): boolean {
    const normalized = normalizeUrl(url, BASE_URL)
    const path = normalized.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+([^?#]*)/i)?.[1] ?? normalized
    return path.includes('/manga/')
  }

  private isNineMangaUrl(url: string): boolean {
    return /^https?:\/\/(?:www\.)?ninemanga\.com(?:[/:?#]|$)/i.test(normalizeUrl(url, BASE_URL))
  }

  private isKnownGateUrl(url: string): boolean {
    const normalized = normalizeUrl(url, BASE_URL).toLowerCase()
    if (this.isNineMangaUrl(normalized)) return false

    return (
      normalized.includes('/go/ennm/') ||
      normalized.includes('/go/jump/') ||
      normalized.includes('type=enninemanga') ||
      normalized.includes('sweettoothrecipes.com') ||
      normalized.includes('financemasterpro.com')
    )
  }

  private resolveReaderChapterUrl(chapter: Chapter): string {
    const rawStoredUrl = chapter.additionalInfo?.url ?? chapter.chapterId
    const storedUrl = normalizeUrl(rawStoredUrl, BASE_URL)
    const canonicalUrl = this.canonicalNineMangaChapterUrl(chapter)
    const shouldUseCanonical = Boolean(canonicalUrl) && !this.isNineMangaChapterUrl(storedUrl)
    const finalUrl = shouldUseCanonical ? canonicalUrl : storedUrl || canonicalUrl

    if (shouldUseCanonical) {
      console.log(`[NineManga] Reader using canonical URL instead of stored URL: ${canonicalUrl}`)
    }

    return finalUrl
  }

  private canonicalNineMangaChapterUrl(chapter: Chapter): string {
    const chapterId = this.chapterIdFromUrl(chapter.additionalInfo?.url ?? chapter.chapterId)
    const mangaSlug = this.mangaSlugFromMangaId(chapter.sourceManga.mangaId)

    if (!chapterId || !mangaSlug) return ''

    return normalizeUrl(`/chapter/${mangaSlug}/${chapterId}.html`, BASE_URL)
  }

  private mangaSlugFromMangaId(mangaId: string): string {
    const normalized = normalizeUrl(mangaId, BASE_URL)
    const match = normalized.match(/\/manga\/([^/?#]+)\.html/i)
    return match?.[1] ?? ''
  }

  private isNineMangaChapterUrl(url: string): boolean {
    const normalized = normalizeUrl(url, BASE_URL).toLowerCase()

    return (
      /^https:\/\/(?:www\.)?ninemanga\.com\//.test(normalized) &&
      normalized.includes('/chapter/') &&
      /\.html(?:[?#].*)?$/.test(normalized)
    )
  }

  private readerBaseUrl(url: string): string {
    const base = url.split('?')[0] ?? url
    return base.replace(/-\d+-\d+\.html$/i, '.html')
  }

  private sourceFlowKey(url: string): string {
    return url.replace(/&amp;/g, '&').replace(/#.*$/, '')
  }

  private async getHeaders(referer = BASE_URL) {
    return mergeHeaders(await defaultBrowserHeaders(referer), {
      accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
    })
  }

  private async getReaderHeaders(referer = BASE_URL) {
    return mergeHeaders(await defaultBrowserHeaders(BASE_URL), {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      cookie: 'ninemanga_list_num=1',
      referer: this.isNineMangaUrl(referer) ? referer : BASE_URL,
    })
  }

  private async prepareReaderChapter(chapter: Chapter): Promise<Chapter> {
    if (chapter.additionalInfo?.bookId) return chapter

    const sourceMangaId = chapter.sourceManga.mangaId
    if (!sourceMangaId) return chapter

    try {
      const details = await this.getMangaData(sourceMangaId)
      const matchingChapter = details.chapters.find(
        (candidate) => this.numericChapterId(candidate.additionalInfo?.url ?? candidate.chapterId) ===
          this.numericChapterId(chapter.additionalInfo?.url ?? chapter.chapterId)
      )

      if (!matchingChapter?.additionalInfo?.bookId) return chapter

      return {
        ...chapter,
        additionalInfo: {
          ...chapter.additionalInfo,
          bookId: matchingChapter.additionalInfo.bookId,
          url: chapter.additionalInfo?.url ?? matchingChapter.additionalInfo.url,
        },
      }
    } catch (error) {
      console.log(`[NineManga] Could not refresh manga metadata for reader unlock: ${String(error)}`)
      return chapter
    }
  }

  private setReaderUnlockCookie(chapter: Chapter, chapterIdOverride?: string): void {
    const bookId = chapter.additionalInfo?.bookId
    const chapterId = chapterIdOverride || this.chapterIdFromUrl(chapter.additionalInfo?.url ?? chapter.chapterId)
    if (!this.setCookie || !bookId || !chapterId) return

    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const domains = ['ninemanga.com', 'www.ninemanga.com', '.ninemanga.com']

    for (const domain of domains) {
      this.setCookie({
        name: `lrgarden_visit_check_${bookId}`,
        value: chapterId,
        domain,
        path: '/',
        expires,
      })
      this.setCookie({
        name: 'ninemanga_book_visited',
        value: '1',
        domain,
        path: '/',
        expires,
      })
      console.log(`[NineManga] Set reader unlock cookies for book ${bookId}, chapter ${chapterId}, domain ${domain}`)
    }
  }

  private setReaderListCookie(): void {
    if (!this.setCookie) return

    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const domains = ['ninemanga.com', 'www.ninemanga.com', '.ninemanga.com']

    for (const domain of domains) {
      this.setCookie({
        name: 'ninemanga_list_num',
        value: '1',
        domain,
        path: '/',
        expires,
      })
    }
  }

  private numericChapterId(value: string): string {
    return value.match(/\/(\d+)(?:[-/.?]|$)/)?.[1] ?? ''
  }

  private chapterIdFromUrl(value: string): string {
    return this.parser.parseExternalSourceChapterIdFromUrl(value) || this.numericChapterId(value)
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

export function isNineMangaSectionId(value: string): value is NineMangaSectionId {
  return SECTIONS.some((section) => section.id === value)
}
