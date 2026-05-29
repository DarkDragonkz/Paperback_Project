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
  NineMangaChapterPage,
  NineMangaMobileSearchItem,
  NineMangaMangaData,
  NineMangaSectionId,
} from './NineMangaModels'
import { NineMangaParser } from './NineMangaParser'

const BASE_URL = 'https://www.ninemanga.com/'
const HTML_CACHE_TTL_MS = 2 * 60 * 1000
const MANGA_DATA_CACHE_TTL_MS = 5 * 60 * 1000
const MAX_CACHE_ENTRIES = 30

interface CacheEntry<T> {
  expiresAt: number
  value: T
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
    const chapterUrl = normalizeUrl(chapter.additionalInfo?.url ?? chapter.chapterId, BASE_URL)
    if (!chapterUrl) throw new Error('Invalid NineManga chapter URL')

    const pageRefs = await this.resolveChapterPageRefs(chapterUrl, BASE_URL, 0, new Set<string>())
    const pages: string[] = []

    for (const pageRef of pageRefs) {
      if (pageRef.imageUrl) {
        pages.push(pageRef.imageUrl)
        continue
      }

      const pageHtml = await this.getHtml(pageRef.url, chapterUrl)
      const imageUrl = this.parser.parseImage(pageHtml.body, pageHtml.url)
      if (imageUrl) pages.push(imageUrl)
    }

    const uniquePages = uniqueStrings(pages)
    console.log(`[NineManga] Reader images returned: ${uniquePages.length}`)

    return {
      id: preparedChapter.chapterId,
      mangaId: preparedChapter.sourceManga.mangaId,
      pages: uniquePages,
    }
  }

  private async resolveChapterPageRefs(
    chapter: Chapter,
    chapterUrl: string
  ): Promise<NineMangaChapterPage[]> {
    const attemptedSourceUrls = new Set<string>()
    const failedSourceChapterIds = new Set<string>()
    console.log(
      `[NineManga] Reader unlock cookies prepared before reader request: book=${chapter.additionalInfo?.bookId ?? 'unknown'}, chapter=${this.chapterIdFromUrl(chapter.additionalInfo?.url ?? chapter.chapterId) || 'unknown'}, url=${chapterUrl}`
    )
    const firstPage = await this.getHtml(chapterUrl)
    let pageRefs = this.parser.parseChapterPage(firstPage.body, firstPage.url)

    console.log(`[NineManga] Reader first page URL: ${firstPage.url}`)
    console.log(`[NineManga] Reader first page status: ${firstPage.status}`)
    console.log(`[NineManga] Reader first page HTML length: ${firstPage.body.length}`)
    console.log(`[NineManga] Reader first page has manga_pic: ${firstPage.body.includes('manga_pic')}`)
    console.log(`[NineManga] Reader first page has sl-page: ${firstPage.body.includes('sl-page')}`)
    console.log(`[NineManga] Reader first page has all_imgs_url: ${firstPage.body.includes('all_imgs_url')}`)
    console.log(`[NineManga] Reader first page has go/jump: ${firstPage.body.includes('/go/jump/')}`)
    console.log(`[NineManga] Reader first page has go/ennm: ${firstPage.body.includes('/go/ennm/')}`)
    console.log(`[NineManga] Reader first page has movietop: ${firstPage.body.includes('.movietop.cc/')}`)
    console.log(`[NineManga] Reader first page has /comics/: ${firstPage.body.includes('/comics/')}`)
    console.log(`[NineManga] Reader parseChapterPage result count: ${pageRefs.length}`)
    console.log(`[NineManga] Reader first page preview: ${firstPage.body.slice(0, 800)}`)

    if (pageRefs.length > 0) return pageRefs

    const requestedCanonicalReader = this.isCanonicalNineMangaReaderUrl(chapterUrl)
    const responseCanonicalReader = this.isCanonicalNineMangaReaderUrl(firstPage.url)
    const shouldAvoidExternalSource = requestedCanonicalReader || responseCanonicalReader

    if (!shouldAvoidExternalSource) {
      pageRefs = await this.resolveSourceSelection(
        chapter,
        firstPage.body,
        firstPage.url,
        attemptedSourceUrls,
        failedSourceChapterIds
      )
      if (pageRefs.length > 0) return pageRefs
    } else {
      console.log(
        `[NineManga] Skipping external source selector because requested reader was canonical: requested=${chapterUrl}, response=${firstPage.url}`
      )
    }

    const candidates = this.chapterReaderCandidates(chapterUrl).filter(
      (candidate) => candidate !== chapterUrl
    )

    for (const candidate of candidates) {
      const candidateChapterId = this.chapterIdFromUrl(candidate)
      if (
        candidateChapterId &&
        failedSourceChapterIds.has(candidateChapterId) &&
        !this.isCanonicalNineMangaReaderUrl(candidate)
      ) {
        console.log(`[NineManga] Skipping failed external/source candidate for cid ${candidateChapterId}`)
        continue
      }

      const page = await this.getHtml(candidate)
      pageRefs = this.parser.parseChapterPage(page.body, page.url)
      if (pageRefs.length > 0) return pageRefs

      const requestedCandidateCanonical = this.isCanonicalNineMangaReaderUrl(candidate)
      const responseCandidateCanonical = this.isCanonicalNineMangaReaderUrl(page.url)
      const shouldAvoidCandidateExternalSource = requestedCandidateCanonical || responseCandidateCanonical

      if (!shouldAvoidCandidateExternalSource) {
        pageRefs = await this.resolveSourceSelection(
          chapter,
          page.body,
          page.url,
          attemptedSourceUrls,
          failedSourceChapterIds
        )
        if (pageRefs.length > 0) return pageRefs
      } else {
        console.log(
          `[NineManga] Skipping external source selector on canonical fallback reader request: requested=${candidate}, response=${page.url}`
        )
      }

      console.log(`[NineManga] No reader pages found at ${candidate}; trying fallback`)
    }

    return []
  }

  private async resolveSourceSelection(
    chapter: Chapter,
    html: string,
    referer: string,
    attemptedSourceUrls: Set<string>,
    failedSourceChapterIds: Set<string>
  ): Promise<NineMangaChapterPage[]> {
    const sourceSelectionUrl = this.parser.parseSourceSelectionUrl(html)
    if (!sourceSelectionUrl) return []

    const externalChapterId =
      this.parser.parseExternalSourceChapterId(html) ||
      this.parser.parseExternalSourceChapterIdFromUrl(sourceSelectionUrl) ||
      this.chapterIdFromUrl(sourceSelectionUrl)
    const sourceKey = this.sourceFlowKey(sourceSelectionUrl)

    if (attemptedSourceUrls.has(sourceKey)) {
      console.log(`[NineManga] Skipping already attempted source selector: ${sourceSelectionUrl}`)
      if (externalChapterId) failedSourceChapterIds.add(externalChapterId)
      return []
    }

    if (externalChapterId && failedSourceChapterIds.has(externalChapterId)) {
      console.log(`[NineManga] Skipping source selector for failed cid ${externalChapterId}`)
      return []
    }

    attemptedSourceUrls.add(sourceKey)
    if (externalChapterId) this.setReaderUnlockCookie(chapter, externalChapterId)

    console.log(`[NineManga] Following chapter source selector: ${sourceSelectionUrl}`)
    const sourcePage = await this.getHtml(sourceSelectionUrl, referer)
    let pageRefs = this.parser.parseChapterPage(sourcePage.body, sourcePage.url)
    if (pageRefs.length > 0) return pageRefs

    const nestedSourceUrl = this.parser.parseSourceSelectionUrl(sourcePage.body)
    if (nestedSourceUrl && nestedSourceUrl !== sourceSelectionUrl) {
      console.log(`[NineManga] Following nested chapter source selector: ${nestedSourceUrl}`)
      const nestedPage = await this.getHtml(nestedSourceUrl, sourcePage.url)
      pageRefs = this.parser.parseChapterPage(nestedPage.body, nestedPage.url)
      if (pageRefs.length > 0) return pageRefs
    }

    console.log(`[NineManga] Source selector did not produce reader pages: ${sourceSelectionUrl}`)
    if (externalChapterId) failedSourceChapterIds.add(externalChapterId)
    return []
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
      type: 'simpleCarouselItem',
      mangaId: item.mangaId,
      imageUrl: item.imageUrl,
      title: item.title,
      subtitle: item.genres.join(', ') || item.latestChapterTitle,
      contentRating: this.contentRatingForGenres(item.genres),
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

  private isMangaUrl(url: string): boolean {
    const normalized = normalizeUrl(url, BASE_URL)
    const path = normalized.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+([^?#]*)/i)?.[1] ?? normalized
    return path.includes('/manga/')
  }

  private resolveReaderChapterUrl(chapter: Chapter): string {
    const rawStoredUrl = chapter.additionalInfo?.url ?? chapter.chapterId
    const storedUrl = normalizeUrl(rawStoredUrl, BASE_URL)
    const chapterId = this.chapterIdFromUrl(rawStoredUrl)
    const mangaSlug = this.mangaSlugFromMangaId(chapter.sourceManga.mangaId)
    const canonicalUrl = this.canonicalNineMangaChapterUrl(chapter)
    const shouldUseCanonical = Boolean(canonicalUrl) && !this.isNineMangaChapterUrl(storedUrl)
    const finalUrl = shouldUseCanonical ? canonicalUrl : storedUrl || canonicalUrl

    console.log(`[NineManga] Reader stored URL: ${storedUrl}`)
    console.log(`[NineManga] Reader extracted chapter id: ${chapterId}`)
    console.log(`[NineManga] Reader extracted manga slug: ${mangaSlug}`)
    console.log(`[NineManga] Reader canonical URL: ${canonicalUrl}`)
    if (shouldUseCanonical) {
      console.log(`[NineManga] Reader using canonical URL instead of stored URL: ${canonicalUrl}`)
    }
    console.log(`[NineManga] Reader final URL: ${finalUrl}`)

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

  private stripWarningParamFromChapterUrl(url: string): string {
    if (!url.includes('/chapter/')) return url

    return url
      .replace(/\?waring=1&/i, '?')
      .replace(/&waring=1&/i, '&')
      .replace(/\?waring=1$/i, '')
      .replace(/&waring=1$/i, '')
      .replace(/\?$/i, '')
      .replace(/&$/i, '')
  }

  private isCanonicalNineMangaReaderUrl(url: string): boolean {
    const normalized = normalizeUrl(url, BASE_URL).toLowerCase()

    return (
      /^https:\/\/(?:www\.)?ninemanga\.com\/chapter\//.test(normalized) &&
      /\.html(?:[?#].*)?$/.test(normalized)
    )
  }

  private chapterReaderCandidates(url: string): string[] {
    const base = this.readerBaseUrl(url)
    const stem = base.endsWith('.html')
      ? base.replace(/\.html$/i, '')
      : base.replace(/\/$/i, '')
    const candidates = [url]

    candidates.push(`${stem}-10-1.html`)
    candidates.push(`${stem}-6-1.html`)
    candidates.push(`${stem}-3-1.html`)
    candidates.push(`${stem}-1-1.html`)
    candidates.push(`${stem}/`)

    return uniqueStrings(candidates.filter(Boolean))
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
