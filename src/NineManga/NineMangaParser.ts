import {
  ContentRating,
  type Chapter,
  type SearchResultItem,
  type SourceManga,
  type TagSection,
} from '@paperback/types'
import * as cheerio from 'cheerio'
import type { Cheerio, CheerioAPI } from 'cheerio'
import type { AnyNode } from 'domhandler'

import { cleanText } from '../common/parsing/html'
import { uniqueBy, uniqueStrings } from '../common/utils/array'
import { orderChaptersForReading } from '../common/utils/chapters'
import { normalizeUrl, pathIdFromUrl } from '../common/utils/url'
import type {
  NineMangaChapterPage,
  NineMangaChapterPageResult,
  NineMangaListingItem,
  NineMangaListingPage,
  NineMangaMangaData,
} from './NineMangaModels'

const ADULT_TAGS = new Set(['adult', 'hentai', 'smut'])
const MATURE_TAGS = new Set(['mature', 'ecchi'])
const BAD_IMAGE_PATTERN = /(logo|icon|avatar|sprite|blank|spacer|ads?|advert|tracking|tracker|pixel|analytics|counter|button|captcha|favicon|doubleclick|googlesyndication|google-analytics|facebook)/i

export class NineMangaParser {
  constructor(private readonly baseUrl: string) {}

  parseListingPage(html: string, currentUrl = this.baseUrl): NineMangaListingPage {
    const $ = cheerio.load(html)
    const items: NineMangaListingItem[] = []

    $('dl.bookinfo').each((_, element) => {
      const item = $(element)
      const mangaAnchor = item.find('a.bookname[href]').first()
      const mangaUrl = normalizeUrl(mangaAnchor.attr('href'), currentUrl)
      const title = cleanText(mangaAnchor.text()) || cleanText(mangaAnchor.attr('title'))

      if (!mangaUrl || !title) return

      const chapterAnchor = item.find('a[href*="/chapter/"]').first()
      const chapterUrl = normalizeUrl(chapterAnchor.attr('href'), currentUrl)

      items.push({
        mangaId: pathIdFromUrl(mangaUrl, this.baseUrl),
        title,
        imageUrl: normalizeUrl(this.getImageUrl(item.find('img').first(), currentUrl), currentUrl),
        url: mangaUrl,
        genres: [],
        latestChapterId: chapterUrl ? pathIdFromUrl(chapterUrl, this.baseUrl) : undefined,
        latestChapterTitle: cleanText(chapterAnchor.text()) || undefined,
      })
    })

    return {
      items: uniqueBy(items, (item) => item.mangaId),
      nextUrl: this.parseNextPageUrl($, currentUrl),
    }
  }

  parseListing(html: string): NineMangaListingItem[] {
    return this.parseListingPage(html).items
  }

  parseManga(html: string, mangaId: string, shareUrl: string): NineMangaMangaData {
    const $ = cheerio.load(html)
    const root = $('div.bookintro').first()
    const rawTitle =
      cleanText(root.find('li > span:not([class])').first().text()) ||
      cleanText(root.find('h1, h2').first().text()) ||
      this.titleFromDocument($) ||
      this.titleFromMangaId(mangaId)
    const title = cleanText(rawTitle.replace(/\s+Manga$/i, ''))
    const genres = uniqueStrings(root.find('li[itemprop="genre"] a').map((_, element) => cleanText($(element).text())).get())
    const author = cleanText(root.find('li a[itemprop="author"]').first().text())
    const status = this.normalizeStatus(cleanText(root.find('li a.red').first().text()))
    const warningUrl = normalizeUrl($('a[href*="waring=1"]').first().attr('href'), this.baseUrl) || undefined
    const isAdult = Boolean(warningUrl) || this.hasAdultTags(genres)
    const additionalInfo = {
      ...(author ? { Author: author } : {}),
      ...(status ? { Status: status } : {}),
    }

    return {
      mangaId,
      title,
      imageUrl: normalizeUrl(this.getImageUrl(root.find('img[itemprop="image"]').first(), shareUrl), shareUrl),
      author,
      status,
      synopsis: cleanText(root.find('p[itemprop="description"]').first().text()),
      genres,
      shareUrl,
      isAdult,
      warningUrl,
      chapters: this.parseChapters($, mangaId, title),
      additionalInfo,
    }
  }

  parseChapterPageResult(html: string, currentUrl: string): NineMangaChapterPageResult {
    const $ = cheerio.load(html)

    // Important: prefer real page images over redirect/server links.
    // Some NineManga mirror pages contain ad/intermediate anchors plus a valid all_imgs_url payload.
    // Following the anchor first can send the reader to fake article/popup domains and lose the pages.
    const allImageUrls = this.parseAllImageUrls(html, currentUrl)
    if (allImageUrls.length > 0) {
      return {
        pages: allImageUrls.map((imageUrl, index) => ({
          url: `${currentUrl}#page-${index + 1}`,
          imageUrl,
        })),
      }
    }

    const readerImages = this.parseReaderImages($, currentUrl)
    if (readerImages.length > 1) {
      return {
        pages: readerImages.map((imageUrl, index) => ({
          url: `${currentUrl}#page-${index + 1}`,
          imageUrl,
        })),
      }
    }

    const pageRefs = this.parsePageOptions($, currentUrl)
    if (pageRefs.length > 0) return { pages: pageRefs }

    if (readerImages.length === 1) {
      return {
        pages: readerImages.map((imageUrl, index) => ({
          url: `${currentUrl}#page-${index + 1}`,
          imageUrl,
        })),
      }
    }

    const nextUrl =
      this.parseServerUrl($, currentUrl) ||
      this.parseRedirectUrl(html, currentUrl) ||
      this.parseMetaRefreshUrl($, currentUrl)

    if (nextUrl) return { pages: [], nextUrl }

    return { pages: [] }
  }

  parseChapterPage(html: string, currentUrl: string): NineMangaChapterPage[] {
    return this.parseChapterPageResult(html, currentUrl).pages
  }

  parseImage(html: string, currentUrl = this.baseUrl): string | undefined {
    const $ = cheerio.load(html)
    return this.parseAllImageUrls(html, currentUrl)[0] || this.parseReaderImages($, currentUrl)[0] || undefined
  }

  toSourceManga(data: NineMangaMangaData): SourceManga {
    return {
      mangaId: data.mangaId,
      mangaInfo: {
        primaryTitle: data.title,
        secondaryTitles: [],
        thumbnailUrl: data.imageUrl,
        synopsis: data.synopsis,
        contentRating: data.isAdult ? ContentRating.ADULT : this.contentRatingForGenres(data.genres),
        author: data.author,
        artist: data.artist,
        status: data.status,
        tagGroups: this.toTagGroups(data.genres),
        shareUrl: data.shareUrl,
        additionalInfo: data.additionalInfo,
      },
    }
  }

  toSearchResult(item: NineMangaListingItem): SearchResultItem {
    return {
      mangaId: item.mangaId,
      title: item.title,
      subtitle: item.latestChapterTitle,
      imageUrl: item.imageUrl,
      contentRating: this.contentRatingForGenres(item.genres),
    }
  }

  contentRatingForGenres(genres: string[]): ContentRating {
    const normalized = genres.map((genre) => genre.toLowerCase())
    if (normalized.some((genre) => ADULT_TAGS.has(genre))) return ContentRating.ADULT
    if (normalized.some((genre) => MATURE_TAGS.has(genre))) return ContentRating.MATURE

    return ContentRating.EVERYONE
  }

  imageHeaders(imageUrl: string): Record<string, string> | undefined {
    return /img\d+\.niadd\.com/i.test(imageUrl)
      ? { referer: this.baseUrl }
      : undefined
  }

  private parseChapters($: CheerioAPI, mangaId: string, mangaTitle: string): Chapter[] {
    const sourceManga: SourceManga = {
      mangaId,
      mangaInfo: {
        primaryTitle: mangaTitle,
        secondaryTitles: [],
        thumbnailUrl: '',
        synopsis: '',
        contentRating: ContentRating.MATURE,
      },
    }
    const chapters: Chapter[] = []

    $('ul.sub_vol_ul > li').each((index, element) => {
      const item = $(element)
      const anchor = item.find('a.chapter_list_a[href]').first()
      const chapterUrl = normalizeUrl(anchor.attr('href'), this.baseUrl)
      const title = this.cleanChapterTitle(cleanText(anchor.text()), mangaTitle)

      if (!chapterUrl || !title) return

      chapters.push({
        chapterId: pathIdFromUrl(chapterUrl, this.baseUrl),
        sourceManga,
        langCode: 'en',
        chapNum: this.parseChapterNumber(title),
        title,
        publishDate: this.parseChapterDate(cleanText(item.find('span').first().text())),
        sortingIndex: index,
        additionalInfo: {
          url: chapterUrl,
        },
      })
    })

    return orderChaptersForReading(uniqueBy(chapters, (chapter) => chapter.chapterId))
  }

  private parseNextPageUrl($: CheerioAPI, currentUrl: string): string | undefined {
    const href = $('ul.pageList > li:last-child > a.l[href]').first().attr('href')
    return normalizeUrl(href, currentUrl) || undefined
  }

  private parseServerUrl($: CheerioAPI, currentUrl: string): string {
    const candidates = $('section.section div.post-content-body > a[href]')
      .map((_, element) => $(element).attr('href') ?? '')
      .get()

    for (const candidate of candidates) {
      const normalized = normalizeUrl(candidate, currentUrl)
      if (!normalized) continue
      if (/^(?:javascript|mailto|tel):/i.test(candidate)) continue
      if (normalized === normalizeUrl(currentUrl, this.baseUrl)) continue

      return normalized
    }

    return ''
  }

  private parseRedirectUrl(html: string, currentUrl: string): string {
    const patterns = [
      /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
      /(?:window\.)?location\.(?:replace|assign)\(\s*["']([^"']+)["']\s*\)/i,
    ]

    for (const pattern of patterns) {
      const redirect = html.match(pattern)?.[1]
      const normalized = normalizeUrl(this.decodeJsString(redirect ?? ''), currentUrl)
      if (normalized) return normalized
    }

    return ''
  }

  private parseMetaRefreshUrl($: CheerioAPI, currentUrl: string): string {
    const content = $('meta[http-equiv]').filter((_, element) => {
      return /^refresh$/i.test($(element).attr('http-equiv') ?? '')
    }).first().attr('content') ?? ''

    const redirect = content.match(/url\s*=\s*([^;]+)/i)?.[1]?.trim().replace(/^["']|["']$/g, '')
    return normalizeUrl(this.decodeHtmlEntities(redirect ?? ''), currentUrl)
  }

  private parsePageOptions($: CheerioAPI, currentUrl: string): NineMangaChapterPage[] {
    const imageUrl = this.normalizeImageUrl(
      $('div.pic_box img.manga_pic, img.manga_pic, .pic_box img').first().attr('src'),
      currentUrl
    )
    const normalizedCurrentUrl = normalizeUrl(currentUrl, this.baseUrl)
    const pages: NineMangaChapterPage[] = []

    $('select#page option[value], select.sl-page option[value]').each((_, option) => {
      const pageOption = $(option)
      const pageUrl = normalizeUrl(pageOption.attr('value'), currentUrl)
      if (!pageUrl) return

      pages.push({
        url: pageUrl,
        imageUrl:
          imageUrl && (pageOption.attr('selected') !== undefined || pageUrl === normalizedCurrentUrl)
            ? imageUrl
            : undefined,
      })
    })

    if (pages.length > 0) return uniqueBy(pages, (page) => page.url)

    return imageUrl ? [{ url: normalizedCurrentUrl, imageUrl }] : []
  }

  private parseAllImageUrls(html: string, currentUrl: string): string[] {
    const images: string[] = []

    for (const match of html.matchAll(/["']?all_imgs_url["']?\s*[:=]\s*\[\s*([\s\S]*?)\s*,?\s*]/gi)) {
      const rawArray = match[1] ?? ''
      try {
        const values = JSON.parse(`[${rawArray.replace(/,\s*$/, '')}]`) as unknown[]
        for (const value of values) {
          const imageUrl = this.normalizeImageUrl(typeof value === 'string' ? value : '', currentUrl)
          if (this.isValidPageImage(imageUrl)) images.push(imageUrl)
        }
      } catch {
        for (const imageMatch of rawArray.matchAll(/(["'])((?:\\.|(?!\1)[\s\S])*?)\1/g)) {
          const imageUrl = this.normalizeImageUrl(this.decodeScriptUrl(imageMatch[2] ?? ''), currentUrl)
          if (this.isValidPageImage(imageUrl)) images.push(imageUrl)
        }
      }
    }

    return uniqueStrings(images)
  }

  private parseReaderImages($: CheerioAPI, currentUrl: string): string[] {
    const images: string[] = []

    $('div.pic_box img.manga_pic, img.manga_pic, .pic_box img, #manga img, .reader img, .chapter img, img[src*="niadd"], img[src*="blogspot"], img[src*="blogger"], img[src*="googleusercontent"]').each((_, element) => {
      images.push(...this.imageUrlsFromAttributes($(element), currentUrl))
    })

    $('img').each((_, element) => {
      for (const imageUrl of this.imageUrlsFromAttributes($(element), currentUrl)) {
        if (this.isValidPageImage(imageUrl)) images.push(imageUrl)
      }
    })

    return uniqueStrings(images)
  }

  private imageUrlsFromAttributes(image: Cheerio<AnyNode>, currentUrl: string): string[] {
    const images: string[] = []
    const attributes = ['src', 'data-src', 'data-original', 'lazy-src', 'data-lazy-src', 'srcset', 'data-srcset']

    for (const attribute of attributes) {
      for (const imageUrl of this.imageUrlsFromValue(image.attr(attribute), currentUrl)) {
        if (this.isValidPageImage(imageUrl)) images.push(imageUrl)
      }
    }

    return images
  }

  private imageUrlsFromValue(value: string | undefined, currentUrl: string): string[] {
    if (!value) return []

    const decodedValue = this.decodeScriptUrl(value)
    const images: string[] = []

    for (const part of decodedValue.split(',')) {
      const candidate = part.trim().split(/\s+/)[0]
      const imageUrl = this.normalizeImageUrl(candidate, currentUrl)
      if (imageUrl) images.push(imageUrl)
    }

    return images
  }

  private getImageUrl(image: Cheerio<AnyNode>, currentUrl: string): string {
    const raw =
      image.attr('src') ||
      image.attr('data-src') ||
      image.attr('data-original') ||
      image.attr('lazy-src') ||
      image.attr('data-lazy-src') ||
      ''

    return normalizeUrl(this.decodeHtmlEntities(raw), currentUrl)
  }

  private normalizeImageUrl(value: string | undefined, currentUrl = this.baseUrl): string {
    return normalizeUrl(this.decodeScriptUrl(value ?? ''), currentUrl)
  }

  private isValidPageImage(url: string): boolean {
    if (!url || BAD_IMAGE_PATTERN.test(url)) return false

    const normalized = url.toLowerCase()

    // Known NineManga image hosts/patterns first.
    if (/img\d+\.niadd\.com/i.test(normalized)) return true
    if (normalized.includes('niadd.com')) return true
    if (normalized.includes('nineanime.com/files/')) return true
    if (normalized.includes('.movietop.cc/')) return true
    if (normalized.includes('blogger.googleusercontent.com')) return true
    if (normalized.includes('bp.blogspot.com') || normalized.includes('blogspot.com')) return true
    if (normalized.includes('googleusercontent.com')) return true

    // Some mirrors expose comic pages under generic /comics/ paths.
    if (normalized.includes('/comics/')) return /\.(?:webp|jpe?g|png|gif)(?:[?#].*)?$/i.test(normalized)

    // Last fallback for all_imgs_url payloads on temporary mirror domains.
    // Keep this only for direct image extensions and rely on BAD_IMAGE_PATTERN to reject ads/icons.
    return /\.(?:webp|jpe?g|png|gif)(?:[?#].*)?$/i.test(normalized)
  }

  private cleanChapterTitle(title: string, mangaTitle: string): string {
    const escapedTitle = mangaTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return cleanText(title.replace(new RegExp(`^${escapedTitle}\\s*`, 'i'), ''))
  }

  private parseChapterNumber(title: string): number {
    const chapter = title.match(/(?:ch(?:apter)?\.?\s*)?(\d+(?:\.\d+)?)/i)?.[1]
    return chapter ? Number(chapter) : 0
  }

  private parseChapterDate(value: string): Date | undefined {
    const text = cleanText(value)
    const absolute = new Date(text)
    if (text && !Number.isNaN(absolute.getTime())) return absolute

    const ago = text.match(/(\d+)\s+(minute|minutes|hour|hours)\s+ago/i)
    if (!ago) return undefined

    const amount = Number(ago[1])
    const multiplier = /^hour/i.test(ago[2]) ? 60 * 60 * 1000 : 60 * 1000
    return new Date(Date.now() - amount * multiplier)
  }

  private normalizeStatus(value: string): string {
    const normalized = value.toLowerCase()
    if (/ongoing|in corso/.test(normalized)) return 'ongoing'
    if (/completed|completato/.test(normalized)) return 'completed'

    return 'unknown'
  }

  private titleFromDocument($: CheerioAPI): string {
    return cleanText($('title').first().text().replace(/\s+Manga.*$/i, ''))
  }

  private titleFromMangaId(mangaId: string): string {
    const slug = mangaId.match(/\/manga\/([^/?#]+)\.html/i)?.[1] ?? mangaId
    return decodeURIComponent(slug)
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private hasAdultTags(genres: string[]): boolean {
    return genres.some((genre) => ADULT_TAGS.has(genre.toLowerCase()))
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
      .replace(/&nbsp;/g, ' ')
  }

  private decodeJsString(value: string): string {
    return this.decodeScriptUrl(value)
  }

  private decodeScriptUrl(value: string): string {
    return this.decodeHtmlEntities(value)
      .trim()
      .replace(/^["']|["']$/g, '')
      .replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\x([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\\//g, '/')
      .replace(/\\\\/g, '\\')
  }
}
