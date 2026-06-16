import { ContentRating, type Chapter, type SearchResultItem, type SourceManga, type TagSection } from '@paperback/types'
import * as cheerio from 'cheerio'
import type { Cheerio, CheerioAPI } from 'cheerio'
import type { AnyNode } from 'domhandler'

import { cleanText, safeAttr, safeText } from '../common/parsing/html'
import { uniqueBy, uniqueStrings } from '../common/utils/array'
import { normalizeUrl, pathIdFromUrl } from '../common/utils/url'
import type { WeebCentralListingItem, WeebCentralMangaData } from './WeebCentralModels'

const SERIES_URL_PATTERN = /^https:\/\/weebcentral\.com\/series\/[A-Z0-9]+\/[^/?#]+\/?$/i
const CHAPTER_URL_PATTERN = /^https:\/\/weebcentral\.com\/chapters\/[A-Z0-9]+\/?$/i
const READER_IMAGE_PATTERN = /^https:\/\/(?:(?:[^/?#]+\.)?planeptune\.us|temp\.compsci88\.com)\//i
const BAD_IMAGE_PATTERN = /(brand|logo|favicon|apple-touch-icon|broken_image|cover\/)/i

export class WeebCentralParser {
  constructor(private readonly baseUrl: string) {}

  parseCatalogItems(html: string): WeebCentralListingItem[] {
    const $ = cheerio.load(html)
    const items: WeebCentralListingItem[] = []

    $('a[href*="/series/"]').each((_, element) => {
      const anchor = $(element)
      const url = normalizeUrl(anchor.attr('href'), this.baseUrl)
      if (!this.isSeriesUrl(url)) return

      const title =
        cleanText(anchor.find('.line-clamp-2, .truncate').first().text()) ||
        cleanText(anchor.text()) ||
        this.titleFromSeriesUrl(url)
      if (!title) return

      items.push({
        mangaId: pathIdFromUrl(url, this.baseUrl),
        title,
        imageUrl: this.coverFromElement($, anchor, url),
        url,
      })
    })

    return uniqueBy(items, (item) => item.mangaId)
  }

  parseManga(html: string, mangaId: string, shareUrl: string): WeebCentralMangaData {
    const $ = cheerio.load(html)
    const metadata = this.parseMetadata($)
    const title =
      cleanText($('h1').first().text()) ||
      cleanText($('meta[property="og:title"]').attr('content'))?.replace(/\s+\|\s+Weeb Central$/i, '') ||
      this.titleFromSeriesUrl(shareUrl)
    const imageUrl = normalizeUrl(
      safeAttr($, 'meta[property="og:image"]', 'content') ||
        this.firstImageAttribute($('.aspect-4\\/6 img, picture img, img[alt$="cover"]').first()),
      this.baseUrl
    )
    const author = metadata['Author(s)'] || metadata.Author

    return {
      mangaId,
      title,
      imageUrl,
      author,
      artist: author,
      status: this.normalizeStatus(metadata.Status),
      synopsis: this.parseSynopsis($),
      genres: this.parseGenres($),
      shareUrl,
      chapters: this.parseChapters($, mangaId, title, imageUrl),
      additionalInfo: metadata,
    }
  }

  parseFullChapterListUrl(html: string, currentUrl: string): string {
    const $ = cheerio.load(html)
    return normalizeUrl($('button[hx-get*="/full-chapter-list"]').first().attr('hx-get'), currentUrl || this.baseUrl)
  }

  parseChapterImages(html: string, currentUrl: string): string[] {
    const $ = cheerio.load(html)
    const images: string[] = []
    const readerImages = $('img', 'section.cursor-pointer')
    const candidates = readerImages.length > 0 ? readerImages : $('section img, img')

    candidates.each((_, element) => {
      const image = $(element)
      for (const imageUrl of this.imageUrlsFromElement(image, currentUrl)) {
        if (this.isReaderImage(imageUrl)) images.push(imageUrl)
      }
    })

    return uniqueStrings(images)
  }

  chapterImagesUrl(rawUrl: string): string {
    const chapterUrl = this.canonicalChapterUrl(rawUrl)
    return chapterUrl ? `${chapterUrl}/images?reading_style=long_strip` : ''
  }

  canonicalChapterUrl(rawUrl: string): string {
    const normalized = normalizeUrl(rawUrl, this.baseUrl).replace(/[?#].*$/, '').replace(/\/images\/?$/i, '')
    return this.isChapterUrl(normalized) ? normalized : ''
  }

  toSourceManga(data: WeebCentralMangaData): SourceManga {
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

  toSearchResult(item: WeebCentralListingItem): SearchResultItem {
    return {
      mangaId: item.mangaId,
      title: item.title,
      imageUrl: item.imageUrl,
      contentRating: ContentRating.MATURE,
    }
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

    $('#chapter-list a[href*="/chapters/"], a[href*="/chapters/"]').each((index, element) => {
      const anchor = $(element)
      const url = this.canonicalChapterUrl(anchor.attr('href') ?? '')
      if (!url) return

      const row = anchor.closest('div')
      const title =
        cleanText(anchor.find('.grow > span').first().text()) ||
        cleanText(anchor.find('span').filter((_, span) => /(?:chapter|prologue|extra|one-shot)/i.test($(span).text())).first().text()) ||
        cleanText(anchor.text()) ||
        this.titleFromChapterUrl(url)
      if (!title) return

      chapters.push({
        chapterId: pathIdFromUrl(url, this.baseUrl),
        sourceManga,
        langCode: 'en',
        volume: 0,
        chapNum: this.parseChapterNumber(title),
        title,
        publishDate: this.parseDate(row.find('time').first().attr('datetime') || cleanText(row.find('time').first().text())),
        sortingIndex: index,
        additionalInfo: {
          url,
        },
      })
    })

    const uniqueChapters = uniqueBy(chapters, (chapter) => chapter.chapterId)

    return uniqueChapters.map((chapter, index) => ({
      ...chapter,
      sortingIndex: uniqueChapters.length - index - 1,
    }))
  }

  private parseMetadata($: CheerioAPI): Record<string, string> {
    const metadata: Record<string, string> = {}

    $('li').each((_, element) => {
      const item = $(element)
      const label = cleanText(item.find('strong').first().text()).replace(/:$/, '')
      if (!label || label === 'Description' || label === 'Track') return

      const value = cleanText(item.clone().children('strong').remove().end().text())
      if (value && !metadata[label]) metadata[label] = value
    })

    return metadata
  }

  private parseSynopsis($: CheerioAPI): string {
    const descriptionLabel = $('li strong').filter((_, element) => /^Description$/i.test(cleanText($(element).text()))).first()
    const description = cleanText(descriptionLabel.closest('li').find('p').first().text())
    return description || cleanText($('meta[property="og:description"]').attr('content'))
  }

  private parseGenres($: CheerioAPI): string[] {
    return uniqueStrings(
      $('a[href*="included_tag="]')
        .toArray()
        .map((element) => cleanText($(element).text()))
        .filter(Boolean)
    )
  }

  private coverFromElement($: CheerioAPI, anchor: Cheerio<AnyNode>, seriesUrl: string): string {
    const image = anchor.find('img').first()
    const imageUrl = normalizeUrl(this.firstImageAttribute(image), this.baseUrl)
    if (imageUrl) return imageUrl

    const seriesId = this.seriesIdFromUrl(seriesUrl)
    return seriesId ? `https://temp.compsci88.com/cover/fallback/${seriesId}.jpg` : ''
  }

  private imageUrlsFromElement(image: Cheerio<AnyNode>, currentUrl: string): string[] {
    const images: string[] = []
    for (const attribute of ['data-src', 'data-original', 'src', 'srcset', 'data-srcset']) {
      for (const imageUrl of this.imageUrlsFromValue(image.attr(attribute), currentUrl)) {
        images.push(imageUrl)
      }
    }

    return images
  }

  private imageUrlsFromValue(value: string | undefined, currentUrl: string): string[] {
    if (!value) return []

    const parts = this.decodeHtmlEntities(value).includes(',') ? this.decodeHtmlEntities(value).split(',') : [this.decodeHtmlEntities(value)]
    return parts
      .map((part) => normalizeUrl(part.trim().split(/\s+/)[0], currentUrl || this.baseUrl))
      .filter((url) => Boolean(url) && !url.startsWith('data:'))
  }

  private firstImageAttribute(image: Cheerio<AnyNode>): string {
    return (
      image.attr('src') ||
      image.attr('data-src') ||
      image.attr('data-original') ||
      image.attr('srcset')?.split(/\s+/)[0] ||
      ''
    )
  }

  private isSeriesUrl(url: string): boolean {
    return SERIES_URL_PATTERN.test(url)
  }

  private isChapterUrl(url: string): boolean {
    return CHAPTER_URL_PATTERN.test(url)
  }

  private isReaderImage(url: string): boolean {
    if (!url || BAD_IMAGE_PATTERN.test(url)) return false
    return READER_IMAGE_PATTERN.test(url) && /\.(?:jpe?g|png|webp)(?:[?#].*)?$/i.test(url)
  }

  private seriesIdFromUrl(rawUrl: string): string {
    return normalizeUrl(rawUrl, this.baseUrl).match(/\/series\/([A-Z0-9]+)/i)?.[1] ?? ''
  }

  private titleFromSeriesUrl(rawUrl: string): string {
    const slug = normalizeUrl(rawUrl, this.baseUrl).match(/\/series\/[A-Z0-9]+\/([^/?#]+)/i)?.[1] ?? ''
    return this.titleFromSlug(slug)
  }

  private titleFromChapterUrl(rawUrl: string): string {
    const id = normalizeUrl(rawUrl, this.baseUrl).match(/\/chapters\/([A-Z0-9]+)/i)?.[1] ?? ''
    return id ? `Chapter ${id}` : ''
  }

  private titleFromSlug(slug: string): string {
    return decodeURIComponent(slug)
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private parseChapterNumber(value: string): number {
    const number = value.match(/(?:chapter|ch\.?|prologue|extra|#)\s*(\d+(?:\.\d+)?)/i)?.[1] ?? value.match(/(\d+(?:\.\d+)?)/)?.[1]
    return number ? Number(number) : 0
  }

  private parseDate(value: string | undefined): Date | undefined {
    const date = new Date(value ?? '')
    return Number.isNaN(date.getTime()) ? undefined : date
  }

  private normalizeStatus(value: string | undefined): string | undefined {
    const status = cleanText(value)
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

    return tags.length > 0 ? [{ id: 'tags', title: 'Tags', tags }] : []
  }

  private decodeHtmlEntities(value: string): string {
    return value
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&apos;/g, "'")
  }
}
