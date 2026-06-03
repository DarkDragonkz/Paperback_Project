import { ContentRating, type Chapter, type SearchResultItem, type SourceManga, type TagSection } from '@paperback/types'
import * as cheerio from 'cheerio'
import type { Cheerio, CheerioAPI } from 'cheerio'
import type { AnyNode } from 'domhandler'

import { cleanText, safeAttr, safeText, splitCommaList } from '../common/parsing/html'
import { uniqueBy, uniqueStrings } from '../common/utils/array'
import { normalizeUrl, pathIdFromUrl } from '../common/utils/url'
import type { XoxoComicsListingItem, XoxoComicsMangaData } from './XoxoComicsModels'

const MAX_SYNTHETIC_PAGES = 250
const CHAPTER_PATH_PATTERN = /\/comic\/[^/?#]+\/(?!all(?:\/|$)|\d+(?:\/|$))[^/?#]+(?:\/|$)/i
const READER_IMAGE_PATTERN = /\/comic\/[^/?#]+\/[^/?#]+\/\d+\/\d+\.(?:jpe?g|png|webp)(?:[?#].*)?$/i
const BAD_IMAGE_PATTERN = /(logo|favicon|loading|avatar|ads?|advert|banner|tracking|pixel|blank|spacer|icon|sprite|preloader|loader|captcha|analytics|counter|button|emoji)/i

export class XoxoComicsParser {
  constructor(private readonly baseUrl: string) {}

  parseCatalogItems(html: string, itemSelector = '.items .row > .item'): XoxoComicsListingItem[] {
    const $ = cheerio.load(html)
    const items: XoxoComicsListingItem[] = []

    $(itemSelector).each((_, element) => {
      const item = $(element)
      const mangaAnchor = this.mangaAnchor($, item)
      const mangaUrl = normalizeUrl(mangaAnchor.attr('href'), this.baseUrl)
      const title =
        cleanText(item.find('h3 a[href]').first().text()) ||
        cleanText(item.find('.slide-caption h3 a[href]').first().text()) ||
        cleanText(mangaAnchor.attr('title')) ||
        cleanText(mangaAnchor.text()) ||
        cleanText(item.find('img').first().attr('alt'))

      if (!this.isMangaUrl(mangaUrl) || !title) return

      const latestAnchor = item.find('a[href*="/comic/"]').filter((_, element) => {
        const href = normalizeUrl($(element).attr('href'), this.baseUrl)
        return this.isChapterUrl(href)
      }).first()
      const latestUrl = normalizeUrl(latestAnchor.attr('href'), this.baseUrl)

      items.push({
        mangaId: pathIdFromUrl(mangaUrl, this.baseUrl),
        title: this.cleanTitle(title),
        imageUrl: normalizeUrl(this.firstImageAttribute(item.find('img').first()), this.baseUrl),
        url: mangaUrl,
        genres: [],
        latestChapterId: latestUrl ? pathIdFromUrl(this.canonicalChapterUrl(latestUrl), this.baseUrl) : undefined,
        latestChapterTitle: cleanText(latestAnchor.text()) || cleanText(latestAnchor.attr('title')),
        latestDate: cleanText(item.find('.time').first().text()),
      })
    })

    const catalogItems = uniqueBy(items, (item) => item.mangaId)
    if (catalogItems.length > 0) return catalogItems

    return this.parseLooseMangaLinks($)
  }

  parseManga(html: string, mangaId: string, shareUrl: string): XoxoComicsMangaData {
    const $ = cheerio.load(html)
    const metadata = this.parseMetadata($)
    const jsonData = this.parseComicJson($)
    const title =
      this.cleanTitle(safeText($, '.title-detail') || jsonData.name || this.titleFromDocument($)) ||
      this.titleFromMangaId(mangaId)
    const genres = uniqueStrings([
      ...this.parseGenres(metadata.Genres ?? ''),
      ...this.parseGenres(jsonData.genre ?? ''),
    ])
    const imageUrl = normalizeUrl(
      safeAttr($, '.detail-info .col-image img', 'src') ||
        safeAttr($, 'meta[property="og:image"]', 'content') ||
        jsonData.image,
      this.baseUrl
    )
    const author = metadata['Author(s)'] || jsonData.author

    return {
      mangaId,
      title,
      imageUrl,
      author,
      artist: author,
      status: this.normalizeStatus(metadata.Status),
      synopsis: this.parseSynopsis($),
      genres,
      shareUrl,
      chapters: this.parseChapters($, mangaId, title, imageUrl),
      additionalInfo: metadata,
    }
  }

  parseIssueImages(html: string, currentUrl: string): string[] {
    const $ = cheerio.load(html)
    const images: string[] = []

    $('.reading-detail .page-chapter img, .reading-detail img.single-page, img[data-original*="/comic/"], img[src*="/comic/"]').each((_, element) => {
      const image = $(element)
      for (const imageUrl of this.imageUrlsFromAttributes(image, currentUrl)) {
        if (this.isReaderImage(imageUrl)) images.push(imageUrl)
      }
    })

    const uniqueImages = uniqueStrings(images)
    const totalPages = this.parseTotalPages($)
    if (uniqueImages.length > 1 || totalPages <= uniqueImages.length) return uniqueImages

    const syntheticPages = this.synthesizeImagePages(uniqueImages[0], totalPages)
    return syntheticPages.length > uniqueImages.length ? syntheticPages : uniqueImages
  }

  parseMangaPageUrls(html: string, currentUrl: string): string[] {
    const $ = cheerio.load(html)
    const urls: string[] = []
    const currentMangaPath = this.mangaPathFromUrl(currentUrl)

    $('.pagination a[href]').each((_, element) => {
      const url = normalizeUrl($(element).attr('href'), currentUrl || this.baseUrl)
      if (!url || this.mangaPathFromUrl(url) !== currentMangaPath) return
      if (!/[?&]page=\d+/i.test(url)) return

      urls.push(url)
    })

    return uniqueStrings(urls).sort((left, right) => this.pageNumber(left) - this.pageNumber(right))
  }

  allPagesUrl(rawUrl: string): string {
    const canonical = this.canonicalChapterUrl(rawUrl)
    return canonical ? `${canonical.replace(/\/$/, '')}/all` : ''
  }

  canonicalChapterUrl(rawUrl: string): string {
    const normalized = normalizeUrl(rawUrl, this.baseUrl).replace(/[?#].*$/, '')
    if (!normalized) return ''

    return normalized
      .replace(/\/all\/?$/i, '')
      .replace(/\/\d+\/?$/i, '')
  }

  toSourceManga(data: XoxoComicsMangaData): SourceManga {
    return {
      mangaId: data.mangaId,
      mangaInfo: {
        primaryTitle: data.title,
        secondaryTitles: [],
        thumbnailUrl: data.imageUrl,
        synopsis: data.synopsis,
        contentRating: ContentRating.MATURE,
        author: data.author,
        artist: data.artist,
        status: data.status,
        tagGroups: this.toTagGroups(data.genres),
        shareUrl: data.shareUrl,
        additionalInfo: data.additionalInfo,
      },
    }
  }

  toSearchResult(item: XoxoComicsListingItem): SearchResultItem {
    return {
      mangaId: item.mangaId,
      title: item.title,
      subtitle: this.subtitleForItem(item),
      imageUrl: item.imageUrl,
      contentRating: ContentRating.MATURE,
    }
  }

  subtitleForItem(item: XoxoComicsListingItem): string | undefined {
    return [item.latestChapterTitle, item.latestDate].filter(Boolean).join(' - ') || undefined
  }

  private parseChapters(
    $: CheerioAPI,
    mangaId: string,
    mangaTitle: string,
    thumbnailUrl: string
  ): Chapter[] {
    const sourceManga: SourceManga = {
      mangaId,
      mangaInfo: {
        primaryTitle: mangaTitle,
        secondaryTitles: [],
        thumbnailUrl,
        synopsis: '',
        contentRating: ContentRating.MATURE,
      },
    }
    const chapters: Chapter[] = []

    $('.list-chapter li.row').each((index, element) => {
      const row = $(element)
      if (row.hasClass('heading')) return

      const anchor = row.find('.chapter a[href], a[href*="/comic/"]').first()
      const issueUrl = this.canonicalChapterUrl(anchor.attr('href') ?? '')
      const title = cleanText(anchor.text()) || this.titleFromIssueUrl(issueUrl)
      if (!this.isChapterUrl(issueUrl) || !title) return

      const dateText = cleanText(row.find('.text-center').last().text())

      chapters.push({
        chapterId: pathIdFromUrl(issueUrl, this.baseUrl),
        sourceManga,
        langCode: 'en',
        chapNum: this.parseChapterNumber(title || issueUrl),
        title: this.cleanChapterTitle(title, mangaTitle),
        publishDate: this.parseDate(dateText),
        sortingIndex: index,
        additionalInfo: {
          url: issueUrl,
        },
      })
    })

    return this.withSiteSortingIndex(uniqueBy(chapters, (chapter) => chapter.chapterId))
  }

  private mangaAnchor($: CheerioAPI, item: Cheerio<AnyNode>): Cheerio<AnyNode> {
    const anchors = item.find('a[href]').filter((_, element) => {
      const href = normalizeUrl($(element).attr('href'), this.baseUrl)
      return this.isMangaUrl(href)
    })

    return anchors.first()
  }

  private parseLooseMangaLinks($: CheerioAPI): XoxoComicsListingItem[] {
    const items: XoxoComicsListingItem[] = []

    $('a[href*="/comic/"]').each((_, element) => {
      const anchor = $(element)
      const mangaUrl = normalizeUrl(anchor.attr('href'), this.baseUrl)
      const title = cleanText(anchor.text()) || cleanText(anchor.attr('title'))
      if (!this.isMangaUrl(mangaUrl) || !title) return

      const row = anchor.closest('.item, li, article, div')
      items.push({
        mangaId: pathIdFromUrl(mangaUrl, this.baseUrl),
        title: this.cleanTitle(title),
        imageUrl: normalizeUrl(this.firstImageAttribute(row.find('img').first()), this.baseUrl),
        url: mangaUrl,
        genres: [],
      })
    })

    return uniqueBy(items, (item) => item.mangaId)
  }

  private parseMetadata($: CheerioAPI): Record<string, string> {
    const metadata: Record<string, string> = {}

    $('.detail-info li.row').each((_, element) => {
      const row = $(element)
      const label = cleanText(row.find('.name strong').first().text())
      if (!label) return

      const valueNode = row.find('p').not('.name').first()
      const value = cleanText(valueNode.text())
      if (value) metadata[label] = value
    })

    return metadata
  }

  private parseSynopsis($: CheerioAPI): string {
    const summary = $('.detail-content').first().clone()
    summary.find('h1, h2, h3, script, style').remove()

    return cleanText(summary.text()) || cleanText($('meta[property="og:description"]').attr('content'))
  }

  private parseComicJson($: CheerioAPI): { name?: string; author?: string; genre?: string; image?: string } {
    for (const element of $('script[type="application/ld+json"]').toArray()) {
      const text = cleanText($(element).contents().text())
      if (!text.includes('ComicSeries')) continue

      try {
        const data = JSON.parse(text) as Record<string, unknown>
        return {
          name: typeof data.name === 'string' ? data.name : undefined,
          author: typeof data.author === 'string' ? data.author : undefined,
          genre: typeof data.genre === 'string' ? data.genre : undefined,
          image: typeof data.image === 'string' ? data.image : undefined,
        }
      } catch {
        return {}
      }
    }

    return {}
  }

  private parseTotalPages($: CheerioAPI): number {
    const optionCount = $('#selectPage option')
      .toArray()
      .map((element) => Number(cleanText($(element).text())))
      .filter((page) => Number.isFinite(page) && page > 0)
      .reduce((max, page) => Math.max(max, page), 0)
    if (optionCount > 0) return optionCount

    const totalText = safeText($, '.total-pages')
    const total = Number(totalText.match(/\d+/)?.[0] ?? 0)
    return Number.isFinite(total) ? total : 0
  }

  private synthesizeImagePages(firstImageUrl: string | undefined, totalPages: number): string[] {
    if (!firstImageUrl || totalPages < 2 || totalPages > MAX_SYNTHETIC_PAGES) return []

    const match = firstImageUrl.match(/^(.*\/)(\d+)(\.(?:jpe?g|png|webp))(?:[?#].*)?$/i)
    if (!match?.[1] || !match[3]) return []

    return Array.from({ length: totalPages }, (_, index) => `${match[1]}${index + 1}${match[3]}`)
  }

  private imageUrlsFromAttributes(image: Cheerio<AnyNode>, currentUrl: string): string[] {
    const images: string[] = []
    for (const attribute of ['data-original', 'data-src', 'data-lazy-src', 'src', 'srcset', 'data-srcset']) {
      for (const imageUrl of this.imageUrlsFromValue(image.attr(attribute), currentUrl)) {
        images.push(imageUrl)
      }
    }

    return images
  }

  private imageUrlsFromValue(value: string | undefined, currentUrl: string): string[] {
    if (!value) return []

    const srcsetParts = this.decodeHtmlEntities(value).includes(',') ? this.decodeHtmlEntities(value).split(',') : [this.decodeHtmlEntities(value)]
    const images: string[] = []

    for (const part of srcsetParts) {
      const candidate = part.trim().split(/\s+/)[0]
      const normalized = normalizeUrl(candidate, currentUrl || this.baseUrl)
      if (normalized && !normalized.startsWith('data:')) images.push(normalized)
    }

    return images
  }

  private firstImageAttribute(image: Cheerio<AnyNode>): string {
    return (
      image.attr('data-original') ||
      image.attr('data-src') ||
      image.attr('data-lazy-src') ||
      image.attr('src') ||
      ''
    )
  }

  private isMangaUrl(url: string): boolean {
    return /^https:\/\/xoxocomic\.com\/comic\/[^/?#]+\/?$/i.test(url)
  }

  private isChapterUrl(url: string): boolean {
    return /^https:\/\/xoxocomic\.com\/comic\/[^/?#]+\/(?!all$|\d+$)[^/?#]+\/?$/i.test(url)
  }

  private isReaderImage(url: string): boolean {
    const normalized = url.toLowerCase()
    if (!normalized || normalized.startsWith('data:')) return false
    if (BAD_IMAGE_PATTERN.test(normalized)) return false
    if (!/^https:\/\/xoxocomic\.com\//i.test(url)) return false
    return READER_IMAGE_PATTERN.test(url) || CHAPTER_PATH_PATTERN.test(url)
  }

  private parseGenres(value: string): string[] {
    return splitCommaList(value.replace(/^Genres:\s*/i, ''))
  }

  private normalizeStatus(value: string | undefined): string | undefined {
    const status = cleanText(value)
    if (!status) return undefined
    if (/complete|completed|finished/i.test(status)) return 'Completed'
    if (/ongoing|updating|active/i.test(status)) return 'Ongoing'
    return status
  }

  private cleanTitle(value: string): string {
    return cleanText(value)
      .replace(/\s+-\s+Read Full List of Chapters.*$/i, '')
      .replace(/\s+Comic$/i, '')
  }

  private cleanChapterTitle(value: string, mangaTitle: string): string {
    return cleanText(value)
      .replace(new RegExp(`^${this.escapeRegex(mangaTitle)}\\s*`, 'i'), '')
      .replace(/^[-:]\s*/, '')
  }

  private parseChapterNumber(value: string): number {
    const issue = value.match(/(?:issue\s*#?|#)\s*(\d+(?:\.\d+)?)/i)?.[1]
    if (issue) return Number(issue)

    const tpb = value.match(/(?:_|\b)tpb[_\s-]*(\d+(?:\.\d+)?)/i)?.[1]
    if (tpb) return Number(tpb)

    const slugIssue = value.match(/\/issue-(\d+(?:\.\d+)?)/i)?.[1]
    if (slugIssue) return Number(slugIssue)

    const slugTpb = value.match(/\/tpb-(\d+(?:\.\d+)?)/i)?.[1]
    return slugTpb ? Number(slugTpb) : 0
  }

  private parseDate(value: string): Date | undefined {
    if (!value) return undefined

    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? undefined : date
  }

  private titleFromDocument($: CheerioAPI): string {
    return this.cleanTitle(safeText($, 'title').replace(/\s+\|\s+Xoxocomic.*$/i, ''))
  }

  private titleFromMangaId(mangaId: string): string {
    const slug = mangaId.match(/\/comic\/([^/]+)/)?.[1] ?? mangaId
    return this.titleFromSlug(slug)
  }

  private titleFromIssueUrl(url: string): string {
    const slug = url.match(/\/([^/?#]+)\/?$/)?.[1] ?? ''
    return this.titleFromSlug(slug)
  }

  private titleFromSlug(slug: string): string {
    return decodeURIComponent(slug)
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (character) => character.toUpperCase())
  }

  private mangaPathFromUrl(rawUrl: string): string {
    const normalized = normalizeUrl(rawUrl, this.baseUrl)
    return normalized.match(/\/comic\/[^/?#]+/i)?.[0] ?? ''
  }

  private pageNumber(rawUrl: string): number {
    return Number(rawUrl.match(/[?&]page=(\d+)/i)?.[1] ?? 1)
  }

  private withSiteSortingIndex(chapters: Chapter[]): Chapter[] {
    return chapters.map((chapter, index) => ({
      ...chapter,
      sortingIndex: index,
    }))
  }

  private toTagGroups(genres: string[]): TagSection[] {
    const tags = uniqueStrings(genres).map((genre) => ({
      id: genre.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      title: genre,
    }))

    return tags.length > 0 ? [{ id: 'genres', title: 'Genres', tags }] : []
  }

  private decodeHtmlEntities(value: string): string {
    return value
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&apos;/g, "'")
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
}
