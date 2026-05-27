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

import { defaultBrowserHeaders, mergeHeaders } from '../common/http/headers'
import { CloudflareBypassInProgressError, getJson, getText } from '../common/http/request'
import type { PageMetadata } from '../common/models/Pagination'
import { uniqueStrings } from '../common/utils/array'
import { normalizeUrl, pathIdFromUrl, withQueryParam } from '../common/utils/url'
import type {
  NineMangaListingConfig,
  NineMangaListingItem,
  NineMangaMobileSearchItem,
  NineMangaSectionId,
} from './NineMangaModels'
import { NineMangaParser } from './NineMangaParser'

const BASE_URL = 'https://www.ninemanga.com/'

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
    const chapterUrl = this.withWarning(
      chapter.additionalInfo?.url ?? normalizeUrl(chapter.chapterId, BASE_URL)
    )
    const firstPage = await this.getHtml(chapterUrl)
    const pageRefs = this.parser.parseChapterPage(firstPage.body, firstPage.url)
    const pages: string[] = []

    for (const pageRef of pageRefs) {
      if (pageRef.imageUrl) {
        pages.push(pageRef.imageUrl)
        continue
      }

      const pageHtml = await this.getHtml(this.withWarning(pageRef.url))
      const imageUrl = this.parser.parseImage(pageHtml.body)
      if (imageUrl) pages.push(imageUrl)
    }

    return {
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      pages: uniqueStrings(pages),
    }
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

  private async getMangaData(mangaId: string) {
    const mangaUrl = this.withWarning(normalizeUrl(mangaId, BASE_URL))
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

      if (warningData.chapters.length > 0) return warningData
    }

    if (firstData.chapters.length === 0 && firstData.warningUrl) {
      const fallbackUrl = withQueryParam(mangaUrl, BASE_URL, 'waring', '1')
      const fallbackResponse = await this.getHtml(fallbackUrl)
      return this.parser.parseManga(
        fallbackResponse.body,
        pathIdFromUrl(mangaUrl, BASE_URL),
        fallbackResponse.url
      )
    }

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

  private async getHtml(url: string) {
    return getText(url, await this.getHeaders())
  }

  private withWarning(url: string): string {
    return url ? withQueryParam(url, BASE_URL, 'waring', '1') : ''
  }

  private async getHeaders() {
    return mergeHeaders(await defaultBrowserHeaders(BASE_URL), {
      accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
    })
  }

  private readPage(metadata: Metadata | undefined): number {
    const page = (metadata as PageMetadata | undefined)?.page
    return typeof page === 'number' && page > 0 ? page : 1
  }
}

export function isNineMangaSectionId(value: string): value is NineMangaSectionId {
  return SECTIONS.some((section) => section.id === value)
}
