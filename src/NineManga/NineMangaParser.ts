import {
  ContentRating,
  type Chapter,
  type SearchResultItem,
  type SourceManga,
  type TagSection,
} from '@paperback/types'
import * as cheerio from 'cheerio'
import type { AnyNode } from 'domhandler'

import { cleanText, safeAttr, safeText, splitCommaList } from '../common/parsing/html'
import { uniqueBy, uniqueStrings } from '../common/utils/array'
import { normalizeUrl, pathIdFromUrl, withQueryParam } from '../common/utils/url'
import type {
  NineMangaChapterPage,
  NineMangaListingItem,
  NineMangaMangaData,
  NineMangaMobileSearchItem,
} from './NineMangaModels'

const ADULT_TAGS = new Set(['adult', 'hentai', 'smut'])
const MATURE_TAGS = new Set(['mature', 'ecchi'])
const NON_GENRE_LABELS = new Set([
  'genres',
  'ongoing',
  'completed',
  '0-9',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
])

export type NineMangaReaderPageKind =
  | 'real-reader'
  | 'source-gate'
  | 'cloudflare'
  | 'external-ad'
  | 'dead'

export interface NineMangaGateCandidate {
  url: string
  source: 'href' | 'data-href' | 'data-url' | 'onclick' | 'script' | 'window-location'
  label?: string
}

export class NineMangaParser {
  constructor(private readonly baseUrl: string) {}

  parseListing(html: string): NineMangaListingItem[] {
    const $ = cheerio.load(html)
    const items: NineMangaListingItem[] = []

    $('li').each((_, element) => {
      const item = $(element)
      const mangaAnchor = item.find('dt a[href], dd.book-list a[href]').first()
      const mangaUrl = normalizeUrl(mangaAnchor.attr('href'), this.baseUrl)
      const title =
        safeText($, 'dd.book-list b', item) ||
        cleanText(mangaAnchor.attr('title')) ||
        cleanText(mangaAnchor.text())

      if (!mangaUrl || !title) return

      const chapterAnchor = item.find('dd.chapter a[href]').first()
      const chapterUrl = normalizeUrl(chapterAnchor.attr('href'), this.baseUrl)

      items.push({
        mangaId: pathIdFromUrl(mangaUrl, this.baseUrl),
        title,
        imageUrl: normalizeUrl(safeAttr($, 'dt img[src]', 'src', item), this.baseUrl),
        url: mangaUrl,
        genres: splitCommaList(safeText($, 'dd.book-list span', item)),
        latestChapterId: chapterUrl ? pathIdFromUrl(chapterUrl, this.baseUrl) : undefined,
        latestChapterTitle: cleanText(chapterAnchor.attr('title')) || cleanText(chapterAnchor.text()),
      })
    })

    return uniqueBy(items, (item) => item.mangaId)
  }

  parseManga(html: string, mangaId: string, shareUrl: string): NineMangaMangaData {
    const $ = cheerio.load(html)
    const rawTitle = safeText($, 'div.book-info h1 b')
    const title = rawTitle.replace(/\s+Manga$/i, '') || rawTitle
    const metadata = this.parseMetadata($)
    const genres = this.parseGenres($, metadata)
    const bookId = this.parseBookId(html)
    const warningUrl = normalizeUrl($('a[href*="waring=1"]').first().attr('href'), this.baseUrl) || undefined
    const synopsis = this.parseSynopsis($)
    const isAdult = Boolean(warningUrl) || this.hasAdultTags(genres)

    return {
      mangaId,
      title,
      imageUrl: normalizeUrl(safeAttr($, 'div.book-info dt img[src]', 'src'), this.baseUrl),
      author: metadata['Author(s)'],
      artist: metadata.Artist,
      status: metadata.Status,
      synopsis,
      genres,
      shareUrl,
      isAdult,
      bookId,
      warningUrl,
      chapters: this.parseChapters($, mangaId, title, bookId),
      additionalInfo: metadata,
    }
  }

  parseMobileSearch(items: NineMangaMobileSearchItem[]): SearchResultItem[] {
    const results: SearchResultItem[] = []

    for (const item of items) {
      const imageUrl = normalizeUrl(item[0], this.baseUrl)
      const title = cleanText(item[1])
      const url = normalizeUrl(item[2], this.baseUrl)
      const author = cleanText(item[4])

      if (!title || !url) continue

      results.push({
        mangaId: pathIdFromUrl(url, this.baseUrl),
        title,
        subtitle: author ? `by ${author}` : undefined,
        imageUrl,
        contentRating: ContentRating.MATURE,
      })
    }

    return uniqueBy(
      results,
      (item) => item.mangaId
    )
  }

  parseChapterPage(html: string, currentUrl: string): NineMangaChapterPage[] {
    const normalizedCurrentUrl = normalizeUrl(currentUrl, this.baseUrl)
    const pages: NineMangaChapterPage[] = []

    for (const pageUrl of this.parseReaderPageUrls(html, currentUrl)) {
      pages.push({ url: pageUrl })
    }

    if (pages.length > 0) return uniqueBy(pages, (page) => page.url)

    const images = this.parseReaderImageUrls(html, currentUrl)
    if (images.length > 0) {
      return images.map((imageUrl, index) => ({
        url: `${currentUrl}#page-${index + 1}`,
        imageUrl,
      }))
    }

    return uniqueBy(pages, (page) => page.url || normalizedCurrentUrl)
  }

  parseReaderImageUrls(html: string, currentUrl = this.baseUrl): string[] {
    const $ = cheerio.load(html)
    const images: string[] = []

    images.push(...this.parseAllImageUrls(html, currentUrl))
    images.push(...this.parseImagesFromSelector($, 'div.pic_box img.manga_pic', currentUrl, false))
    images.push(...this.parseImagesFromSelector($, 'img.manga_pic', currentUrl, false))
    images.push(...this.parseImagesFromSelector($, 'a.pic_download img', currentUrl, true))

    const ogImage = this.normalizeImageUrl($('meta[property="og:image"]').first().attr('content'), currentUrl)
    if (this.isReaderImageUrl(ogImage)) images.push(ogImage)

    return uniqueStrings(images.filter((imageUrl) => this.isAllowedReaderImageUrl(imageUrl)))
  }

  parseReaderPageUrls(html: string, currentUrl = this.baseUrl): string[] {
    const $ = cheerio.load(html)
    const pageUrls: string[] = []

    $('select#page option[value], select.sl-page option[value]').each((_, option) => {
      const pageUrl = this.withWarningParam(normalizeUrl($(option).attr('value'), currentUrl || this.baseUrl))
      if (pageUrl) pageUrls.push(pageUrl)
    })

    return uniqueStrings(pageUrls)
  }

  classifyReaderPage(html: string, currentUrl: string): NineMangaReaderPageKind {
    const normalizedUrl = normalizeUrl(currentUrl, this.baseUrl).toLowerCase()
    const normalizedHtml = html.toLowerCase()

    if (!this.isNineMangaUrl(normalizedUrl)) return 'external-ad'

    if (
      normalizedHtml.includes('cf-browser-verification') ||
      normalizedHtml.includes('cf-challenge') ||
      normalizedHtml.includes('challenge-platform') ||
      normalizedHtml.includes('turnstile') ||
      normalizedHtml.includes('captcha') ||
      normalizedHtml.includes('checking if the site connection is secure')
    ) {
      return 'cloudflare'
    }

    if (
      normalizedHtml.includes('img class="manga_pic') ||
      normalizedHtml.includes("img class='manga_pic") ||
      normalizedHtml.includes('div class="pic_box') ||
      normalizedHtml.includes("div class='pic_box") ||
      normalizedHtml.includes('all_imgs_url') ||
      this.parseReaderImageUrls(html, currentUrl).length > 0 ||
      this.parseReaderPageUrls(html, currentUrl).length > 0
    ) {
      return 'real-reader'
    }

    if (this.parseSourceSelectionUrl(html)) return 'source-gate'

    return 'dead'
  }

  parseSourceSelectionUrl(html: string): string | undefined {
    const $ = cheerio.load(html)
    const serverHref = $('section.section div.post-content-body > a[href]').first().attr('href')
    const href =
      serverHref ||
      $('a.vision-button[href*="/go/jump/"]').first().attr('href') ||
      $('a.vision-button[href*="/go/ennm/"]').first().attr('href') ||
      $('a[href*="type=enninemanga"][href*="cid="]').first().attr('href') ||
      $('a[href*="/go/ennm/"]').first().attr('href') ||
      $('a[href*="/go/jump/"]').first().attr('href')

    const cleaned = href?.replace(/&amp;/g, '&').trim()
    const normalizedUrl = normalizeUrl(cleaned, this.baseUrl)
    if (!normalizedUrl) return undefined

    const allowed =
      Boolean(serverHref) ||
      normalizedUrl.startsWith(this.baseUrl) ||
      normalizedUrl.includes('/go/ennm/') ||
      normalizedUrl.includes('/go/jump/') ||
      normalizedUrl.includes('type=enninemanga')

    return allowed ? normalizedUrl : undefined
  }

  parseGateCandidateUrls(html: string, currentUrl: string): string[] {
    return this.parseGateCandidates(html, currentUrl).map((candidate) => candidate.url)
  }

  parseGateCandidates(html: string, currentUrl: string): NineMangaGateCandidate[] {
    const $ = cheerio.load(html)
    const candidates: NineMangaGateCandidate[] = []

    $('a').each((_, element) => {
      const anchor = $(element)
      const label = cleanText(anchor.text()) || cleanText(anchor.attr('title')) || undefined

      this.addGateCandidate(candidates, anchor.attr('href'), currentUrl, 'href', label)
      this.addGateCandidate(candidates, anchor.attr('data-href'), currentUrl, 'data-href', label)
      this.addGateCandidate(candidates, anchor.attr('data-url'), currentUrl, 'data-url', label)
      this.addGateCandidate(candidates, anchor.attr('onclick'), currentUrl, 'onclick', label)
    })

    $('[data-href], [data-url], [onclick]').each((_, element) => {
      const item = $(element)
      const label = cleanText(item.text()) || cleanText(item.attr('title')) || undefined

      this.addGateCandidate(candidates, item.attr('data-href'), currentUrl, 'data-href', label)
      this.addGateCandidate(candidates, item.attr('data-url'), currentUrl, 'data-url', label)
      this.addGateCandidate(candidates, item.attr('onclick'), currentUrl, 'onclick', label)
    })

    $('script').each((_, element) => {
      const script = $(element).html() ?? ''
      for (const match of script.matchAll(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/gi)) {
        this.addGateCandidate(candidates, match[1], currentUrl, 'window-location')
      }

      for (const match of script.matchAll(/["']((?:https?:)?\/\/[^"']+|\/[^"']+)["']/gi)) {
        this.addGateCandidate(candidates, match[1], currentUrl, 'script')
      }
    })

    return uniqueBy(
      candidates.filter((candidate) => this.isUsefulGateCandidateUrl(candidate.url)),
      (candidate) => candidate.url
    )
  }

  parseReaderRedirectUrl(html: string, currentUrl: string): string | undefined {
    const $ = cheerio.load(html)
    const script =
      $('body > script')
        .toArray()
        .map((element) => $(element).html() ?? '')
        .find((content) => content.includes('window.location.href')) ||
      $('script')
        .toArray()
        .map((element) => $(element).html() ?? '')
        .find((content) => content.includes('window.location.href'))

    const target = script?.match(/window\.location\.href\s*=\s*["']([^"']+)["']/i)?.[1]
    const redirectUrl = normalizeUrl(target, currentUrl || this.baseUrl)
    return redirectUrl || undefined
  }

  parseExternalSourceChapterId(html: string): string | undefined {
    const $ = cheerio.load(html)
    const sourceUrl =
      $('a.vision-button[href*="/go/jump/"]').first().attr('href') ||
      $('a.vision-button[href*="/go/ennm/"]').first().attr('href') ||
      $('a[href*="type=enninemanga"][href*="cid="]').first().attr('href') ||
      $('a[href*="/go/ennm/"]').first().attr('href') ||
      $('a.vision-button[href*="/go/"]').first().attr('href') ||
      $('a[href*="/go/"][href*="cid="]').first().attr('href')

    return this.parseExternalSourceChapterIdFromUrl(sourceUrl) || undefined
  }

  parseExternalSourceChapterIdFromUrl(sourceUrl: string | undefined): string {
    if (!sourceUrl) return ''

    const source = sourceUrl.replace(/&amp;/g, '&')
    const queryId = source.match(/[?&]cid=([^&#/]+)/)?.[1]
    const pathId = source.match(/\/go\/[^/?#]+\/(\d+)(?:[/?#]|$)/)?.[1]
    const suffixId = source.match(/\/(\d+)\.html(?:[?#]|$)/)?.[1]
    return queryId || pathId || suffixId || ''
  }

  parseImage(html: string, currentUrl = this.baseUrl): string | undefined {
    return this.parseReaderImageUrls(html, currentUrl)[0] || undefined
  }

  toSourceManga(data: NineMangaMangaData): SourceManga {
    return {
      mangaId: data.mangaId,
      mangaInfo: {
        primaryTitle: data.title,
        secondaryTitles: [],
        thumbnailUrl: data.imageUrl,
        synopsis: data.synopsis,
        contentRating: data.isAdult ? ContentRating.ADULT : ContentRating.MATURE,
        author: data.author,
        artist: data.artist,
        status: data.status,
        tagGroups: this.toTagGroups(data.genres),
        shareUrl: data.shareUrl,
        additionalInfo: data.additionalInfo,
      },
    }
  }

  private parseMetadata($: cheerio.CheerioAPI): Record<string, string> {
    const metadata: Record<string, string> = {}

    $('dd.about-book p').each((_, element) => {
      const row = $(element)
      const label = cleanText(row.find('span').first().text()).replace(/:$/, '')
      if (!label) return

      row.find('span').first().remove()
      metadata[label] = cleanText(row.text())
    })

    return metadata
  }

  private parseChapters(
    $: cheerio.CheerioAPI,
    mangaId: string,
    mangaTitle: string,
    bookId: string
  ): Chapter[] {
    const chapters: Chapter[] = []

    $('ul.chapter-box li').each((index, element) => {
      const item = $(element)
      const longAnchor = item.find('div.chapter-name.long a[href]').first()
      const shortTitle = cleanText(item.find('div.chapter-name.short a').first().text()).replace(/\s*new$/i, '')
      const chapterUrl = normalizeUrl(longAnchor.attr('href'), this.baseUrl)
      const longTitle = cleanText(longAnchor.text()).replace(/\s*new$/i, '')
      const title = longTitle || shortTitle

      if (!chapterUrl || !title) return

      chapters.push({
        chapterId: pathIdFromUrl(chapterUrl, this.baseUrl),
        sourceManga: {
          mangaId,
          mangaInfo: {
            primaryTitle: mangaTitle,
            secondaryTitles: [],
            thumbnailUrl: '',
            synopsis: '',
            contentRating: ContentRating.MATURE,
          },
        },
        langCode: 'en',
        chapNum: this.parseChapterNumber(shortTitle || title),
        title,
        sortingIndex: index,
        additionalInfo: {
          url: chapterUrl,
          bookId,
        },
      })
    })

    return chapters
  }

  private parseSynopsis($: cheerio.CheerioAPI): string {
    let synopsis = ''

    $('dd.short-info p').each((_, element) => {
      const row = $(element)
      const label = cleanText(row.find('b').first().text()).replace(/:$/, '').toLowerCase()
      if (label !== 'summary') return

      synopsis = cleanText(row.find('span').first().text())
      if (synopsis) return false

      row.find('b').first().remove()
      synopsis = cleanText(row.text())
      return false
    })

    return synopsis || safeText($, 'dd.short-info p span') || safeText($, 'dd.short-info span')
  }

  private parseGenres($: cheerio.CheerioAPI, metadata: Record<string, string>): string[] {
    const genres = splitCommaList(metadata.Genres ?? '')

    $('dd.short-info a[href*="/category/"]').each((_, element) => {
      const label = cleanText($(element).text())
      if (!label || NON_GENRE_LABELS.has(label)) return

      genres.push(label)
    })

    return uniqueStrings(genres)
  }

  private parseChapterNumber(title: string): number {
    const matches = [...title.matchAll(/(?:ch(?:apter)?\s*)?(\d+(?:\.\d+)?)/gi)]
    const last = matches.length > 0 ? matches[matches.length - 1]?.[1] : undefined
    return last ? Number(last) : 0
  }

  private parseBookId(html: string): string {
    return html.match(/\bbook_id\s*=\s*["']?(\d+)/)?.[1] ?? ''
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

  private sameUrl(left: string, right: string): boolean {
    return normalizeUrl(left, this.baseUrl) === normalizeUrl(right, this.baseUrl)
  }

  private parseAllImageUrls(html: string, currentUrl = this.baseUrl): string[] {
    const images: string[] = []
    const match = html.match(/all_imgs_url\s*:\s*\[([\s\S]*?)\]/)
    if (!match?.[1]) return images

    for (const imageMatch of match[1].matchAll(/["']([^"']+\.(?:webp|jpe?g|png)(?:\?[^"']*)?)["']/gi)) {
      const imageUrl = this.normalizeImageUrl(imageMatch[1], currentUrl)
      if (imageUrl) images.push(imageUrl)
    }

    return uniqueStrings(images)
  }

  private parseReaderImages($: cheerio.CheerioAPI, currentUrl = this.baseUrl): string[] {
    const images: string[] = []

    $('img.manga_pic').each((_, element) => {
      const image = $(element)
      images.push(...this.imageUrlsFromAttributes(image, false, currentUrl))
    })

    $('img').each((_, element) => {
      const image = $(element)
      images.push(...this.imageUrlsFromAttributes(image, true, currentUrl))
    })

    return uniqueStrings(images)
  }

  private parseImagesFromSelector(
    $: cheerio.CheerioAPI,
    selector: string,
    currentUrl: string,
    requireReaderPath: boolean
  ): string[] {
    const images: string[] = []

    $(selector).each((_, element) => {
      images.push(...this.imageUrlsFromAttributes($(element), requireReaderPath, currentUrl))
    })

    return uniqueStrings(images)
  }

  private addGateCandidate(
    candidates: NineMangaGateCandidate[],
    rawValue: string | undefined,
    currentUrl: string,
    source: NineMangaGateCandidate['source'],
    label?: string
  ): void {
    if (!rawValue) return

    const decodedValue = this.decodeHtmlEntities(rawValue)
    const values = this.extractUrlLikeValues(decodedValue)

    for (const value of values) {
      const normalizedUrl = normalizeUrl(value, currentUrl || this.baseUrl)
      if (normalizedUrl) candidates.push({ url: normalizedUrl, source, label })
    }
  }

  private extractUrlLikeValues(value: string): string[] {
    const values: string[] = []

    for (const match of value.matchAll(/(?:https?:)?\/\/[^\s"',<>\\)]+|\/[A-Za-z0-9][^\s"',<>\\)]*/gi)) {
      values.push(match[0])
    }

    if (values.length > 0) return uniqueStrings(values)

    const trimmed = value.trim()
    if (
      trimmed.startsWith('/') ||
      /^https?:\/\//i.test(trimmed) ||
      trimmed.includes('/go/') ||
      trimmed.includes('/chapter/') ||
      trimmed.includes('cid=') ||
      trimmed.includes('enninemanga')
    ) {
      values.push(trimmed)
    }

    return uniqueStrings(values)
  }

  private isUsefulGateCandidateUrl(url: string): boolean {
    if (!url || this.isBlockedGateCandidateUrl(url)) return false

    const normalized = url.toLowerCase()
    const isNineMangaChapter =
      /^https?:\/\/(?:www\.)?ninemanga\.com\//i.test(url) &&
      normalized.includes('/chapter/')
    const isKnownGate =
      normalized.includes('/go/ennm/') ||
      normalized.includes('/go/jump/') ||
      normalized.includes('type=enninemanga') ||
      normalized.includes('cid=')
    const looksReaderLike =
      normalized.includes('source') ||
      normalized.includes('read') ||
      normalized.includes('reader') ||
      normalized.includes('manga') ||
      normalized.includes('chapter') ||
      normalized.includes('ninemanga')

    return isNineMangaChapter || isKnownGate || looksReaderLike
  }

  private isBlockedGateCandidateUrl(url: string): boolean {
    const normalized = url.toLowerCase()

    return (
      /\.(?:css|js|json|png|jpe?g|webp|gif|svg|ico|woff2?|ttf)(?:[?#].*)?$/i.test(normalized) ||
      normalized.includes('facebook.com') ||
      normalized.includes('twitter.com') ||
      normalized.includes('x.com/') ||
      normalized.includes('instagram.com') ||
      normalized.includes('youtube.com') ||
      normalized.includes('discord.gg') ||
      normalized.includes('google-analytics') ||
      normalized.includes('googletagmanager') ||
      normalized.includes('doubleclick.net') ||
      normalized.includes('/ads') ||
      normalized.includes('/ad/') ||
      normalized.includes('advert') ||
      normalized.includes('utm_') ||
      normalized === this.baseUrl.toLowerCase()
    )
  }

  private imageUrlsFromAttributes(
    image: cheerio.Cheerio<AnyNode>,
    requireReaderPath: boolean,
    currentUrl = this.baseUrl
  ): string[] {
    const images: string[] = []
    const attributes = [
      'src',
      'data-src',
      'data-original',
      'lazy-src',
      'data-lazy-src',
      'srcset',
      'data-srcset',
      'data-lazy-srcset',
    ]

    for (const attribute of attributes) {
      for (const imageUrl of this.imageUrlsFromValue(image.attr(attribute), currentUrl)) {
        if (!requireReaderPath || this.isReaderImageUrl(imageUrl)) images.push(imageUrl)
      }
    }

    return images
  }

  private imageUrlsFromValue(value: string | undefined, currentUrl = this.baseUrl): string[] {
    const images: string[] = []
    if (!value) return images

    const decodedValue = this.decodeHtmlEntities(value)

    for (const match of decodedValue.matchAll(/(?:https?:)?\/\/[^\s"',<>]+\.(?:webp|jpe?g|png)(?:\?[^"',<>\s]*)?/gi)) {
      const imageUrl = this.normalizeImageUrl(match[0], currentUrl)
      if (this.isImageUrl(imageUrl)) images.push(imageUrl)
    }

    if (images.length > 0) return images

    const firstPart = decodedValue.split(/\s+/)[0]
    const imageUrl = this.normalizeImageUrl(firstPart, currentUrl)
    return this.isImageUrl(imageUrl) ? [imageUrl] : []
  }

  private isImageUrl(url: string): boolean {
    return /\.(?:webp|jpe?g|png)(?:[?#].*)?$/i.test(url)
  }

  private isReaderImageUrl(url: string): boolean {
    const normalized = url.toLowerCase()
    return (
      normalized.includes('/comics/') ||
      /\/\/img\d+\.[^/?#]*niadd\.com\//i.test(normalized) ||
      normalized.includes('.niadd.com/') ||
      normalized.includes('.movietop.cc/') ||
      normalized.includes('nineanime.com/files/')
    )
  }

  private isAllowedReaderImageUrl(url: string): boolean {
    if (!this.isImageUrl(url) || !this.isReaderImageUrl(url)) return false

    const normalized = url.toLowerCase()
    return !(
      normalized.includes('placeholder') ||
      normalized.includes('logo') ||
      normalized.includes('banner') ||
      normalized.includes('/ads') ||
      normalized.includes('/ad/') ||
      normalized.includes('advert') ||
      normalized.includes('mangadogs') ||
      normalized.includes('update') ||
      normalized.includes('sweettoothrecipes.com') ||
      normalized.includes('financemasterpro.com')
    )
  }

  private parseInlineReaderImageUrls(html: string, currentUrl = this.baseUrl): string[] {
    const images: string[] = []
    const decodedHtml = this.decodeHtmlEntities(html)

    for (const match of decodedHtml.matchAll(/(?:https?:)?\/\/[^\s"',<>]+\.(?:webp|jpe?g|png)(?:\?[^"',<>\s]*)?/gi)) {
      const imageUrl = this.normalizeImageUrl(match[0], currentUrl)
      if (this.isImageUrl(imageUrl) && this.isReaderImageUrl(imageUrl)) images.push(imageUrl)
    }

    return uniqueStrings(images)
  }

  private normalizeImageUrl(value: string | undefined, currentUrl = this.baseUrl): string {
    return normalizeUrl(this.decodeHtmlEntities(value ?? ''), currentUrl || this.baseUrl)
  }

  private withWarningParam(url: string): string {
    if (!url || !url.includes('/chapter/')) return url

    return withQueryParam(url, this.baseUrl, 'waring', '1')
  }

  private isNineMangaUrl(url: string): boolean {
    return /^https?:\/\/(?:www\.)?ninemanga\.com(?:[/:?#]|$)/i.test(url)
  }

  private decodeHtmlEntities(value: string): string {
    return value
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&apos;/g, "'")
  }

}
