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
import { normalizeUrl, pathIdFromUrl } from '../common/utils/url'
import type {
  NineMangaChapterPage,
  NineMangaListingItem,
  NineMangaMangaData,
  NineMangaMobileSearchItem,
} from './NineMangaModels'

const ADULT_TAGS = new Set(['adult', 'hentai', 'smut'])
const MATURE_TAGS = new Set(['mature', 'ecchi'])

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
    const genres = splitCommaList(metadata.Genres ?? '')
    const warningUrl = normalizeUrl($('a[href*="waring=1"]').first().attr('href'), this.baseUrl) || undefined
    const synopsis =
      safeText($, 'dd.short-info p span') ||
      safeText($, 'dd.short-info span') ||
      safeText($, 'dd.short-info p')
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
    const imageUrl = normalizeUrl($('img.manga_pic[src]').first().attr('src'), this.baseUrl)
    const pages: NineMangaChapterPage[] = []

    $('select.sl-page option[value]').each((_, option) => {
      const pageUrl = normalizeUrl($(option).attr('value'), this.baseUrl)
      if (!pageUrl) return

      pages.push({
        url: pageUrl,
        imageUrl: this.sameUrl(pageUrl, currentUrl) ? imageUrl : undefined,
      })
    })

    if (pages.length === 0 && imageUrl) {
      pages.push({ url: currentUrl, imageUrl })
    }

    return uniqueBy(pages, (page) => page.url)
  }

  parseImage(html: string): string | undefined {
    const $ = cheerio.load(html)
    return normalizeUrl($('img.manga_pic[src]').first().attr('src'), this.baseUrl) || undefined
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
        },
      })
    })

    return chapters
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
}
