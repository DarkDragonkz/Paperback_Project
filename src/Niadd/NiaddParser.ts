import { ContentRating, type Chapter, type SearchResultItem, type SourceManga, type TagSection } from '@paperback/types'
import * as cheerio from 'cheerio'
import type { Cheerio, CheerioAPI } from 'cheerio'
import type { AnyNode } from 'domhandler'

import { cleanText, safeAttr, safeText } from '../common/parsing/html'
import { uniqueBy, uniqueStrings } from '../common/utils/array'
import { orderChaptersForReading } from '../common/utils/chapters'
import { normalizeUrl, pathIdFromUrl } from '../common/utils/url'
import type { NiaddListingItem, NiaddMangaData } from './NiaddModels'

const MANGA_URL_PATTERN = /^https:\/\/www\.niadd\.com\/(?:manga\/[^/?#]+\.html|original\/\d+\.html)$/i
const CHAPTER_URL_PATTERN = /^https:\/\/www\.niadd\.com\/chapter\/[^/?#]+\/\d+(?:-\d+)?(?:\.html)?\/?$/i
const READER_IMAGE_PATTERN = /^https:\/\/img\.niadd\.com\/manga[^?#]*\.(?:jpe?g|png|webp)(?:[?#].*)?$/i
const BAD_IMAGE_PATTERN = /(logo|avatar|ads?|advert|banner|tracking|tracker|pixel|blank|spacer|icon|sprite|loader|captcha|analytics|def_logo|noimg)/i

export class NiaddParser {
  constructor(private readonly baseUrl: string) {}

  parseCatalogItems(html: string): NiaddListingItem[] {
    const $ = cheerio.load(html)
    const items: NiaddListingItem[] = []

    $('a[href*="/manga/"], a[href*="/original/"]').each((_, element) => {
      const anchor = $(element)
      const url = this.canonicalMangaUrl(anchor.attr('href') ?? '')
      if (!url) return

      const row = anchor.closest('.rec-item, .bkslf-book-item, .bookside-original-item, li, article, div')
      const title =
        cleanText(anchor.find('.brief span, [itemprop="name"]').first().text()) ||
        cleanText(anchor.find('img').first().attr('title')) ||
        cleanText(anchor.find('img').first().attr('alt')) ||
        cleanText(anchor.attr('title')) ||
        cleanText(anchor.text()) ||
        this.titleFromMangaUrl(url)
      if (!title) return

      const latestAnchor = row.find('a[href*="/chapter/"]').first()
      const latestUrl = this.canonicalChapterUrl(latestAnchor.attr('href') ?? '')
      const latestTitle = cleanText(latestAnchor.text()) || cleanText(latestAnchor.attr('title'))

      items.push({
        mangaId: pathIdFromUrl(url, this.baseUrl),
        title,
        imageUrl: this.coverFromElement(anchor, row),
        url,
        latestChapterId: latestUrl ? pathIdFromUrl(latestUrl, this.baseUrl) : undefined,
        latestChapterTitle: latestTitle,
        latestDate: safeText($, '.detail-chp-time, .latest-date, time', row),
      })
    })

    return uniqueBy(items, (item) => item.mangaId)
  }

  parseManga(html: string, mangaId: string, shareUrl: string): NiaddMangaData {
    const $ = cheerio.load(html)
    const metadata = this.parseMetadata($)
    const title =
      safeText($, '.book-headline-name') ||
      safeText($, 'h1[itemprop="name"]') ||
      this.titleFromDocument($) ||
      this.titleFromMangaUrl(shareUrl)
    const imageUrl = normalizeUrl(
      safeAttr($, 'meta[property="og:image"]', 'content') ||
        this.firstImageAttribute($('.bookside-img img[itemprop="image"], .bookside-img img').first()),
      this.baseUrl
    )
    const genres = uniqueStrings([
      ...this.parseGenresFromDetailBoxes($),
      ...(metadata.Genres ? this.splitMetadataGenres(metadata.Genres) : []),
    ])

    return {
      mangaId,
      title,
      imageUrl,
      status: this.normalizeStatus(safeText($, '.book-status') || metadata.Status),
      synopsis: this.parseSynopsis($),
      genres,
      shareUrl,
      chapters: this.parseChapters($, mangaId, title, imageUrl),
      additionalInfo: metadata,
    }
  }

  parseFullChapterListUrl(html: string, currentUrl: string): string {
    const $ = cheerio.load(html)
    return normalizeUrl(
      $('.detail-cate-title-added[href$="/chapters.html"], a[href$="/chapters.html"]').first().attr('href'),
      currentUrl || this.baseUrl
    )
  }

  parseReaderPageUrls(html: string, currentUrl: string): string[] {
    const $ = cheerio.load(html)
    const urls: string[] = []

    $('[option_name="page_head"] [option_val], select.sl-page option[value], .mangaread-pagenav option[value]').each((_, element) => {
      const candidate = this.canonicalReaderPageUrl($(element).attr('option_val') || $(element).attr('value') || '')
      if (candidate) urls.push(candidate)
    })

    return uniqueStrings(urls.length > 0 ? urls : [this.canonicalReaderPageUrl(currentUrl)])
  }

  parseChapterImages(html: string, currentUrl: string): string[] {
    const $ = cheerio.load(html)
    const images: string[] = []
    const candidates = $('section.mangaread-img img.manga_pic, img.manga_pic, section.mangaread-img a[href*="img.niadd.com"]')

    candidates.each((_, element) => {
      const node = $(element)
      if (this.isHiddenImage(node)) return

      for (const imageUrl of this.imageUrlsFromElement(node, currentUrl)) {
        if (this.isReaderImage(imageUrl, node)) images.push(imageUrl)
      }
    })

    return uniqueStrings(images)
  }

  canonicalMangaUrl(rawUrl: string): string {
    const normalized = normalizeUrl(rawUrl, this.baseUrl).replace(/[?#].*$/, '')
    return MANGA_URL_PATTERN.test(normalized) ? normalized : ''
  }

  canonicalChapterUrl(rawUrl: string): string {
    const normalized = normalizeUrl(rawUrl, this.baseUrl).replace(/[?#].*$/, '')
    return CHAPTER_URL_PATTERN.test(normalized) ? normalized : ''
  }

  toSourceManga(data: NiaddMangaData): SourceManga {
    return {
      mangaId: data.mangaId,
      mangaInfo: {
        primaryTitle: data.title,
        secondaryTitles: [],
        thumbnailUrl: data.imageUrl,
        synopsis: data.synopsis,
        contentRating: ContentRating.MATURE,
        status: data.status,
        tagGroups: this.toTagGroups(data.genres),
        shareUrl: data.shareUrl,
        additionalInfo: data.additionalInfo,
      },
    }
  }

  toSearchResult(item: NiaddListingItem): SearchResultItem {
    return {
      mangaId: item.mangaId,
      title: item.title,
      subtitle: this.subtitleForItem(item),
      imageUrl: item.imageUrl,
      contentRating: ContentRating.MATURE,
    }
  }

  subtitleForItem(item: NiaddListingItem): string | undefined {
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

    $('.detail-section.detail-chp-list a[href*="/chapter/"], [option_name="chp_head"] [option_val], select option[value*="/chapter/"]').each((index, element) => {
      const node = $(element)
      const url = this.canonicalChapterUrl(node.attr('href') || node.attr('option_val') || node.attr('value') || '')
      if (!url) return

      const row = node.closest('a, li, div')
      const title =
        cleanText(row.find('.detail-chp-name').first().text()) ||
        cleanText(node.attr('option_key')) ||
        cleanText(node.attr('title')) ||
        cleanText(node.text()) ||
        this.titleFromChapterUrl(url)
      if (!title) return

      chapters.push({
        chapterId: pathIdFromUrl(url, this.baseUrl),
        sourceManga,
        langCode: 'en',
        chapNum: this.parseChapterNumber(title, url),
        title,
        publishDate: this.parseDate(row.find('.detail-chp-time, time').first().text()),
        sortingIndex: index,
        additionalInfo: {
          url,
        },
      })
    })

    return orderChaptersForReading(uniqueBy(chapters, (chapter) => chapter.chapterId))
  }

  private parseMetadata($: CheerioAPI): Record<string, string> {
    const metadata: Record<string, string> = {}

    $('.bookside-bookinfo > div').each((_, element) => {
      const row = $(element)
      const label = cleanText(row.find('.bookside-bookinfo-key').first().text()).replace(/:$/, '')
      const value = cleanText(row.find('.bookside-bookinfo-value').text())
      if (label && value && !metadata[label]) metadata[label] = value
    })

    $('.detail-general-cell').each((_, element) => {
      const text = cleanText($(element).text())
      const match = text.match(/^([^:]+):\s*(.+)$/)
      if (match?.[1] && match[2] && !metadata[match[1]]) metadata[match[1]] = cleanText(match[2])
    })

    return metadata
  }

  private parseSynopsis($: CheerioAPI): string {
    const synopsisBox = $('.detail-section-box')
      .filter((_, element) => /^Synopsis$/i.test(cleanText($(element).find('.detail-cate-title').first().text())))
      .first()
    const section = synopsisBox.find('.detail-section.detail-synopsis').first()
    const description = section.length ? section.clone() : $('.detail-section.detail-synopsis').last().clone()

    description.find('script, style, img, .bookside-uploader-info').remove()
    return cleanText(description.text())
  }

  private parseGenresFromDetailBoxes($: CheerioAPI): string[] {
    const genreBox = $('.detail-section-box')
      .filter((_, element) => /^Genres:?$/i.test(cleanText($(element).find('.detail-cate-title').first().text())))
      .first()
    const scope = genreBox.length ? genreBox : $('.bookside-bookinfo')

    return uniqueStrings(
      scope.find('[itemprop="genre"], a[href*="/category/"]')
        .toArray()
        .map((element) => cleanText($(element).text()).replace(/^,\s*/, ''))
        .filter((genre) => Boolean(genre) && !/^\d{4}$/.test(genre))
    )
  }

  private splitMetadataGenres(value: string): string[] {
    return value
      .split(',')
      .map((genre) => cleanText(genre))
      .filter(Boolean)
  }

  private coverFromElement(anchor: Cheerio<AnyNode>, row: Cheerio<AnyNode>): string {
    return normalizeUrl(
      this.firstImageAttribute(anchor.find('img').first()) ||
        this.firstImageAttribute(row.find('img').first()),
      this.baseUrl
    )
  }

  private imageUrlsFromElement(node: Cheerio<AnyNode>, currentUrl: string): string[] {
    const images: string[] = []
    const attributes = ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-url', 'data-cfsrc', 'href', 'srcset', 'data-srcset']

    for (const attribute of attributes) {
      for (const imageUrl of this.imageUrlsFromValue(node.attr(attribute), currentUrl)) {
        images.push(imageUrl)
      }
    }

    return images
  }

  private imageUrlsFromValue(value: string | undefined, currentUrl: string): string[] {
    if (!value) return []

    const decoded = this.decodeHtmlEntities(value)
    const parts = decoded.includes(',') ? decoded.split(',') : [decoded]

    return parts
      .map((part) => normalizeUrl(part.trim().split(/\s+/)[0], currentUrl || this.baseUrl))
      .filter((url) => Boolean(url) && !url.startsWith('data:'))
  }

  private firstImageAttribute(image: Cheerio<AnyNode>): string {
    return (
      image.attr('src') ||
      image.attr('data-src') ||
      image.attr('data-original') ||
      image.attr('data-lazy-src') ||
      image.attr('data-cfsrc') ||
      image.attr('srcset')?.split(/\s+/)[0] ||
      ''
    )
  }

  private canonicalReaderPageUrl(rawUrl: string): string {
    const normalized = normalizeUrl(rawUrl, this.baseUrl).replace(/[?#].*$/, '')
    return CHAPTER_URL_PATTERN.test(normalized) ? normalized : ''
  }

  private isReaderImage(url: string, node: Cheerio<AnyNode>): boolean {
    if (!url || BAD_IMAGE_PATTERN.test(url)) return false
    if (!READER_IMAGE_PATTERN.test(url)) return false

    const className = cleanText(node.attr('class'))
    const id = cleanText(node.attr('id'))
    const alt = cleanText(node.attr('alt'))
    return !BAD_IMAGE_PATTERN.test(`${className} ${id} ${alt}`)
  }

  private isHiddenImage(node: Cheerio<AnyNode>): boolean {
    return this.numberAttribute(node, 'width') === 0 || this.numberAttribute(node, 'height') === 0
  }

  private numberAttribute(node: Cheerio<AnyNode>, attribute: string): number | undefined {
    const value = node.attr(attribute)?.match(/\d+/)?.[0]
    return value ? Number(value) : undefined
  }

  private titleFromDocument($: CheerioAPI): string {
    return cleanText(
      safeText($, 'title')
        .replace(/\s+details,.*$/i, '')
        .replace(/\s+Chapter\s+\d+.*$/i, '')
        .replace(/\s+-\s+Niadd$/i, '')
    )
  }

  private titleFromMangaUrl(rawUrl: string): string {
    const normalized = normalizeUrl(rawUrl, this.baseUrl)
    const slug =
      normalized.match(/\/manga\/([^/?#]+)\.html/i)?.[1] ??
      normalized.match(/\/original\/(\d+)\.html/i)?.[1] ??
      ''

    return this.titleFromSlug(slug)
  }

  private titleFromChapterUrl(rawUrl: string): string {
    const normalized = normalizeUrl(rawUrl, this.baseUrl)
    const title = normalized.match(/\/chapter\/([^/]+)\//i)?.[1] ?? ''
    return this.titleFromSlug(title)
  }

  private titleFromSlug(slug: string): string {
    return decodeURIComponent(slug)
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (character) => character.toUpperCase())
  }

  private parseChapterNumber(title: string, url: string): number {
    const number =
      title.match(/(?:chapter|ch\.?|#)\s*(\d+(?:\.\d+)?)/i)?.[1] ??
      url.match(/\/chapter\/[^/]*?(\d+(?:\.\d+)?)\//i)?.[1] ??
      title.match(/(\d+(?:\.\d+)?)/)?.[1]

    return number ? Number(number) : 0
  }

  private parseDate(value: string): Date | undefined {
    const text = cleanText(value)
    if (!text || /\b(?:ago|yesterday|today)\b/i.test(text)) return undefined

    const date = new Date(text)
    return Number.isNaN(date.getTime()) ? undefined : date
  }

  private normalizeStatus(value: string | undefined): string | undefined {
    const status = cleanText(value).replace(/[()]/g, '')
    if (!status) return undefined
    if (/complete|completed|finished/i.test(status)) return 'Completed'
    if (/ongoing|updating|active/i.test(status)) return 'Ongoing'
    return status
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
}
