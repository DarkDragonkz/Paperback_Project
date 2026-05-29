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

import { cleanText, splitCommaList } from '../common/parsing/html'
import { uniqueBy, uniqueStrings } from '../common/utils/array'
import { orderChaptersForReading } from '../common/utils/chapters'
import { normalizeUrl, pathIdFromUrl } from '../common/utils/url'
import type { ZeurelScanListingItem, ZeurelScanMangaData } from './ZeurelScanModels'

export class ZeurelScanParser {
  constructor(private readonly baseUrl: string) {}

  parseSeries(html: string, currentUrl = this.baseUrl): ZeurelScanListingItem[] {
    const $ = cheerio.load(html)
    const items: ZeurelScanListingItem[] = []

    $('a.series-card[href]').each((_, element) => {
      const card = $(element)
      const url = normalizeUrl(card.attr('href'), currentUrl)
      const title =
        cleanText(card.find('.series-title').first().text()) ||
        cleanText(card.find('img').first().attr('alt')) ||
        cleanText(card.text())
      if (!url || !title) return

      items.push({
        mangaId: pathIdFromUrl(url, this.baseUrl),
        title,
        imageUrl: normalizeUrl(this.imageAttr(card.find('img').first()), currentUrl),
        url,
      })
    })

    return uniqueBy(items, (item) => item.mangaId)
  }

  parseLatest(html: string, currentUrl = this.baseUrl): ZeurelScanListingItem[] {
    const $ = cheerio.load(html)
    const items: ZeurelScanListingItem[] = []

    $('a.latest-row[href]').each((_, element) => {
      const row = $(element)
      const chapterUrl = normalizeUrl(row.attr('href'), currentUrl)
      const title = cleanText(row.find('.latest-title').first().text())
      if (!chapterUrl || !title) return

      const mangaId = this.mangaIdFromChapterUrl(chapterUrl)
      items.push({
        mangaId,
        title,
        imageUrl: normalizeUrl(this.imageAttr(row.find('img').first()), currentUrl),
        url: normalizeUrl(mangaId, this.baseUrl),
        latestChapterId: pathIdFromUrl(chapterUrl, this.baseUrl),
        latestChapterTitle: this.latestChapterTitle(row),
      })
    })

    return uniqueBy(items, (item) => `${item.mangaId}:${item.latestChapterId ?? ''}`)
  }

  parseManga(html: string, mangaId: string, shareUrl: string): ZeurelScanMangaData {
    const $ = cheerio.load(html)
    const info = $('.series-header').first()
    const metadata = this.metadata($, info)
    const title =
      cleanText(info.find('h1').first().text()) ||
      cleanText($('title').first().text().replace(/\s*[–-]\s*ZeurelScan.*$/i, '')) ||
      this.titleFromMangaId(mangaId)
    const genres = uniqueStrings(splitCommaList(metadata.Genere ?? ''))
    const imageUrl = normalizeUrl(this.imageAttr(info.find('img').first()), shareUrl)

    return {
      mangaId,
      title,
      imageUrl,
      synopsis: cleanText(info.find('.series-plot').first().text()),
      status: this.normalizeStatus(metadata.Stato),
      author: metadata.Autore,
      artist: metadata.Artista,
      genres,
      shareUrl,
      chapters: this.parseChapters($, mangaId, title, imageUrl),
      additionalInfo: metadata,
    }
  }

  parseChapterPages(html: string, currentUrl: string): string[] {
    const $ = cheerio.load(html)
    const pages: string[] = []

    $('.reader img, .reader-container img, main img').each((_, element) => {
      const image = $(element)
      const url = normalizeUrl(this.imageAttr(image), currentUrl)
      if (this.isReaderImage(url)) pages.push(url)
    })

    return uniqueStrings(pages)
  }

  toSourceManga(data: ZeurelScanMangaData): SourceManga {
    return {
      mangaId: data.mangaId,
      mangaInfo: {
        primaryTitle: data.title,
        secondaryTitles: [],
        thumbnailUrl: data.imageUrl,
        synopsis: data.synopsis,
        contentRating: this.contentRating(data.genres),
        author: data.author,
        artist: data.artist,
        status: data.status,
        tagGroups: this.toTagGroups(data.genres),
        shareUrl: data.shareUrl,
        additionalInfo: data.additionalInfo,
      },
    }
  }

  toSearchResult(item: ZeurelScanListingItem): SearchResultItem {
    return {
      mangaId: item.mangaId,
      title: item.title,
      subtitle: item.latestChapterTitle,
      imageUrl: item.imageUrl,
      contentRating: ContentRating.EVERYONE,
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
        contentRating: ContentRating.EVERYONE,
      },
    }
    const chapters: Chapter[] = []

    $('div.chapter').each((index, element) => {
      const row = $(element)
      const anchor = row.find('a[href*="/read/"]').first()
      const chapterUrl = normalizeUrl(anchor.attr('href'), this.baseUrl)
      if (!chapterUrl) return

      const title = cleanText(anchor.clone().find('.chapter-date').remove().end().text())
      chapters.push({
        chapterId: pathIdFromUrl(chapterUrl, this.baseUrl),
        sourceManga,
        langCode: 'it',
        chapNum: this.parseChapterNumber(title || row.attr('data-pagina') || ''),
        title,
        publishDate: this.parseDate(cleanText(anchor.find('.chapter-date').first().text())),
        sortingIndex: index,
        additionalInfo: {
          url: chapterUrl,
        },
      })
    })

    return orderChaptersForReading(uniqueBy(chapters, (chapter) => chapter.chapterId))
  }

  private metadata($: CheerioAPI, root: Cheerio<AnyNode>): Record<string, string> {
    const metadata: Record<string, string> = {}

    root.find('p').each((_, element) => {
      const row = $(element)
      const label = cleanText(row.find('strong').first().text()).replace(/:$/, '')
      if (!label || row.hasClass('series-plot')) return

      const valueRow = row.clone()
      valueRow.find('strong').first().remove()
      metadata[label] = cleanText(valueRow.text())
    })

    return metadata
  }

  private latestChapterTitle(row: Cheerio<AnyNode>): string | undefined {
    const pieces = [
      cleanText(row.find('.latest-chapter, .chapter, .latest-subtitle').first().text()),
      cleanText(row.find('.latest-date, .chapter-date').first().text()),
    ].filter(Boolean)

    const fallback = cleanText(row.text()).replace(cleanText(row.find('.latest-title').first().text()), '')
    return pieces.join(' - ') || fallback || undefined
  }

  private mangaIdFromChapterUrl(chapterUrl: string): string {
    const match = chapterUrl.match(/\/read\/([^/?#]+)\//i)
    return match ? `/serie/${match[1]}` : pathIdFromUrl(chapterUrl, this.baseUrl)
  }

  private imageAttr(image: Cheerio<AnyNode>): string {
    return (
      image.attr('src') ||
      image.attr('data-src') ||
      image.attr('data-lazy-src') ||
      ''
    )
  }

  private isReaderImage(url: string): boolean {
    if (!url || !/\.(?:jpe?g|png|webp)(?:[?#].*)?$/i.test(url)) return false

    return !/(donazioni|ko-fi|cover|logo|avatar|favicon|z1\.png)/i.test(url)
  }

  private parseChapterNumber(value: string): number {
    const number = cleanText(value).match(/#?\s*(\d+(?:\.\d+)?)/)?.[1]
    return number ? Number(number) : 0
  }

  private parseDate(value: string): Date | undefined {
    const match = value.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/)
    if (!match) return undefined

    return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]))
  }

  private normalizeStatus(value: string | undefined): string {
    const normalized = cleanText(value).toLowerCase()
    if (/corso|ongoing/.test(normalized)) return 'ongoing'
    if (/complet|finito|conclus/.test(normalized)) return 'completed'

    return 'unknown'
  }

  private titleFromMangaId(mangaId: string): string {
    const slug = mangaId.split('/').filter(Boolean).pop() ?? mangaId
    return decodeURIComponent(slug)
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (character) => character.toUpperCase())
  }

  private contentRating(genres: string[]): ContentRating {
    const normalized = genres.map((genre) => genre.toLowerCase())
    if (normalized.some((genre) => ['hentai', 'adulti', 'adulto', 'smut'].includes(genre))) {
      return ContentRating.ADULT
    }
    if (normalized.some((genre) => ['ecchi', 'seinen', 'horror', 'maturo'].includes(genre))) {
      return ContentRating.MATURE
    }

    return ContentRating.EVERYONE
  }

  private toTagGroups(genres: string[]): TagSection[] {
    const tags = uniqueStrings(genres).map((genre) => ({
      id: genre.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      title: genre,
    }))

    return tags.length > 0 ? [{ id: 'genres', title: 'Generi', tags }] : []
  }
}
