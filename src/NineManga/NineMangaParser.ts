import {
  ContentRating,
  type Chapter,
  type SearchResultItem,
  type SourceManga,
  type TagSection,
} from '@paperback/types'
import * as cheerio from 'cheerio'

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
      warningUrl,
      chapters: this.parseChapters($, mangaId, title),
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
    const $ = cheerio.load(html)
    const allImageUrls = this.parseAllImageUrls(html)
    if (allImageUrls.length > 0) {
      return allImageUrls.map((imageUrl, index) => ({
        url: `${currentUrl}#page-${index + 1}`,
        imageUrl,
      }))
    }

    const readerImages = this.parseReaderImages($)
    if (readerImages.length > 1) {
      return readerImages.map((imageUrl, index) => ({
        url: `${currentUrl}#page-${index + 1}`,
        imageUrl,
      }))
    }

    const imageUrl = normalizeUrl($('img.manga_pic[src]').first().attr('src'), this.baseUrl)
    const normalizedCurrentUrl = this.withWarning(currentUrl)
    const pages: NineMangaChapterPage[] = []

    $('select.sl-page option[value]').each((_, option) => {
      const pageOption = $(option)
      const pageUrl = this.withWarning(normalizeUrl(pageOption.attr('value'), this.baseUrl))
      if (!pageUrl) return

      pages.push({
        url: pageUrl,
        imageUrl:
          pageOption.attr('selected') !== undefined || this.sameUrl(pageUrl, normalizedCurrentUrl)
            ? imageUrl
            : undefined,
      })
    })

    if (pages.length === 0 && (imageUrl || readerImages[0])) {
      pages.push({ url: normalizedCurrentUrl, imageUrl: imageUrl || readerImages[0] })
    }

    return uniqueBy(pages, (page) => page.url)
  }

  parseSourceSelectionUrl(html: string): string | undefined {
    const $ = cheerio.load(html)
    const sourceUrl =
      $('a.vision-button[href*="/go/jump/"][href*="cid="]').first().attr('href') ||
      $('a.vision-button[href*="/go/"]').first().attr('href') ||
      $('a[href*="/go/jump/"][href*="cid="]').first().attr('href')

    const normalizedUrl = normalizeUrl(sourceUrl, this.baseUrl)
    if (!normalizedUrl.startsWith(this.baseUrl)) return undefined

    return normalizedUrl || undefined
  }

  parseExternalSourceChapterId(html: string): string | undefined {
    const $ = cheerio.load(html)
    const sourceUrl =
      $('a.vision-button[href*="/go/"]').first().attr('href') ||
      $('a[href*="/go/"][href*="cid="]').first().attr('href')

    return this.chapterIdFromExternalSource(sourceUrl) || undefined
  }

  parseImage(html: string): string | undefined {
    const $ = cheerio.load(html)
    return (
      this.parseAllImageUrls(html)[0] ||
      this.parseReaderImages($)[0] ||
      undefined
    )
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

  private parseChapters($: cheerio.CheerioAPI, mangaId: string, mangaTitle: string): Chapter[] {
    const chapters: Chapter[] = []

    $('ul.chapter-box li').each((index, element) => {
      const item = $(element)
      const longAnchor = item.find('div.chapter-name.long a[href]').first()
      const shortTitle = cleanText(item.find('div.chapter-name.short a').first().text()).replace(/\s*new$/i, '')
      const chapterUrl = normalizeUrl(longAnchor.attr('href'), this.baseUrl)
      const warningChapterUrl = this.withWarning(chapterUrl)
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
          url: warningChapterUrl,
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

  private withWarning(url: string): string {
    return url ? withQueryParam(url, this.baseUrl, 'waring', '1') : ''
  }

  private parseAllImageUrls(html: string): string[] {
    const images: string[] = []
    const match = html.match(/all_imgs_url\s*:\s*\[([\s\S]*?)\]/)
    if (!match?.[1]) return images

    for (const imageMatch of match[1].matchAll(/["']([^"']+\.(?:webp|jpe?g|png)(?:\?[^"']*)?)["']/gi)) {
      const imageUrl = normalizeUrl(imageMatch[1], this.baseUrl)
      if (imageUrl) images.push(imageUrl)
    }

    return uniqueStrings(images)
  }

  private parseReaderImages($: cheerio.CheerioAPI): string[] {
    const images: string[] = []

    $('img.manga_pic, img[src*="/comics/"], img[data-src*="/comics/"], img[data-original*="/comics/"]').each((_, element) => {
      const image = $(element)
      const imageUrl = this.firstImageUrl(
        image.attr('src'),
        image.attr('data-src'),
        image.attr('data-original'),
        image.attr('lazy-src')
      )

      if (imageUrl) images.push(imageUrl)
    })

    return uniqueStrings(images)
  }

  private firstImageUrl(...values: Array<string | undefined>): string {
    for (const value of values) {
      const normalized = normalizeUrl(value, this.baseUrl)
      if (/\.(?:webp|jpe?g|png)(?:[?#].*)?$/i.test(normalized)) return normalized
    }

    return ''
  }

  private chapterIdFromExternalSource(sourceUrl: string | undefined): string {
    if (!sourceUrl) return ''

    const source = sourceUrl.replace(/&amp;/g, '&')
    const queryId = source.match(/[?&]cid=([^&#/]+)/)?.[1]
    const pathId = source.match(/\/go\/[^/?#]+\/(\d+)(?:[/?#]|$)/)?.[1]
    return queryId || pathId || ''
  }

}
