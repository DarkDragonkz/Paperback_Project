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

import { cleanText, splitCommaList } from '../parsing/html'
import { uniqueBy, uniqueStrings } from '../utils/array'
import { orderChaptersForReading } from '../utils/chapters'
import { normalizeUrl, pathIdFromUrl } from '../utils/url'
import type {
  FoolSlideConfig,
  FoolSlideListingItem,
  FoolSlideMangaData,
} from './FoolSlideModels'

export class FoolSlideParser {
  constructor(private readonly config: FoolSlideConfig) {}

  parseDirectory(html: string, currentUrl: string): FoolSlideListingItem[] {
    const $ = cheerio.load(html)
    const selector = this.config.directorySelector ?? 'div.group, .series_element'
    const items: FoolSlideListingItem[] = []

    $(selector).each((_, element) => {
      const root = $(element)
      const anchor = this.seriesAnchor(root)
      const url = normalizeUrl(anchor.attr('href'), currentUrl)
      const title = cleanText(anchor.attr('title')) || cleanText(anchor.text())
      if (!url || !title || !/\/series\//i.test(url)) return

      items.push({
        mangaId: pathIdFromUrl(url, this.config.baseUrl),
        title,
        url,
        imageUrl: this.thumbnail(root, currentUrl),
      })
    })

    return uniqueBy(items, (item) => item.mangaId)
  }

  parseLatest(html: string, currentUrl: string): FoolSlideListingItem[] {
    const $ = cheerio.load(html)
    const items: FoolSlideListingItem[] = []

    $('div.group').each((_, element) => {
      const root = $(element)
      const seriesAnchor = this.seriesAnchor(root)
      const chapterAnchor = root.find('a[href*="/read/"]').first()
      const seriesUrl = normalizeUrl(seriesAnchor.attr('href'), currentUrl)
      const chapterUrl = normalizeUrl(chapterAnchor.attr('href'), currentUrl)
      const title = cleanText(seriesAnchor.attr('title')) || cleanText(seriesAnchor.text())
      if (!seriesUrl || !chapterUrl || !title) return

      items.push({
        mangaId: pathIdFromUrl(seriesUrl, this.config.baseUrl),
        title,
        url: seriesUrl,
        imageUrl: this.thumbnail(root, currentUrl),
        latestChapterId: pathIdFromUrl(chapterUrl, this.config.baseUrl),
        latestChapterTitle: cleanText(chapterAnchor.attr('title')) || cleanText(chapterAnchor.text()),
        latestChapterDate: this.parseDate(cleanText(root.find('.meta_r').first().text())),
      })
    })

    return uniqueBy(items, (item) => `${item.mangaId}:${item.latestChapterId ?? ''}`)
  }

  parseManga(html: string, mangaId: string, shareUrl: string): FoolSlideMangaData {
    const $ = cheerio.load(html)
    const info = $('div.info').first()
    const title =
      cleanText($('h1').first().text()) ||
      cleanText($('title').first().text().replace(/\s*::.*$/i, '')) ||
      this.titleFromMangaId(mangaId)
    const infoText = cleanText(info.text())
    const metadata = this.metadata(infoText)
    const imageUrl = this.detailsThumbnail($, shareUrl)
    const genres = uniqueStrings(splitCommaList(metadata.Genere ?? metadata.Genres ?? ''))

    return {
      mangaId,
      title,
      imageUrl,
      synopsis: metadata.Trama || metadata.Synopsis || metadata.Description || infoText,
      author: metadata.Autore || metadata.Author,
      artist: metadata.Artista || metadata.Artist,
      genres,
      status: this.normalizeStatus(metadata.Stato || metadata.Status),
      shareUrl,
      chapters: this.parseChapters($, mangaId, title, imageUrl),
      additionalInfo: metadata,
    }
  }

  parseChapterPages(html: string, currentUrl: string): string[] {
    const pagesJson = html.match(/var\s+pages\s*=\s*(\[[\s\S]*?\]);/)?.[1]
    if (pagesJson) {
      try {
        const pages = JSON.parse(pagesJson) as Array<{ url?: string }>
        return pages
          .map((page) => normalizeUrl(page.url, currentUrl))
          .filter(Boolean)
      } catch (error) {
        console.log(`[${this.config.sourceName}] Could not parse FoolSlide pages JSON: ${String(error)}`)
      }
    }

    const $ = cheerio.load(html)
    const pages: string[] = []
    $('img.open, #page img, .page img').each((_, element) => {
      const url = normalizeUrl(this.imageAttr($(element)), currentUrl)
      if (url && !/logo|avatar|favicon/i.test(url)) pages.push(url)
    })

    return uniqueStrings(pages)
  }

  toSourceManga(data: FoolSlideMangaData): SourceManga {
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

  toSearchResult(item: FoolSlideListingItem): SearchResultItem {
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
    const selector = this.config.chapterListSelector ?? 'div.group div.element, div.list div.element'

    $(selector).each((index, element) => {
      const row = $(element)
      const anchor = row.find('a[href*="/read/"]').first()
      const chapterUrl = normalizeUrl(anchor.attr('href'), this.config.baseUrl)
      const title = cleanText(anchor.attr('title')) || cleanText(anchor.text())
      if (!chapterUrl || !title || /^\d+$/.test(title)) return

      chapters.push({
        chapterId: pathIdFromUrl(chapterUrl, this.config.baseUrl),
        sourceManga,
        langCode: this.config.language,
        chapNum: this.chapterNumber(title, chapterUrl),
        title,
        publishDate: this.parseDate(cleanText(row.find('.meta_r').first().text())),
        sortingIndex: index,
        additionalInfo: {
          url: chapterUrl,
        },
      })
    })

    return orderChaptersForReading(uniqueBy(chapters, (chapter) => chapter.chapterId))
  }

  private seriesAnchor(root: Cheerio<AnyNode>): Cheerio<AnyNode> {
    return root.find('a[title][href*="/series/"]').first()
      .add(root.find('a[href*="/series/"]').first())
      .first()
  }

  private thumbnail(root: Cheerio<AnyNode>, currentUrl: string): string {
    const url = normalizeUrl(this.imageAttr(root.find('img').first()), currentUrl)
    return url.replace('/thumb_', '/')
  }

  private detailsThumbnail($: CheerioAPI, currentUrl: string): string {
    const image = $('div.thumbnail img, table.thumb img').first()
    return normalizeUrl(this.imageAttr(image), currentUrl).replace('/thumb_', '/')
  }

  private metadata(infoText: string): Record<string, string> {
    const metadata: Record<string, string> = {}
    const normalized = infoText.replace(/\s+/g, ' ').trim()

    for (const label of ['Autore', 'Author', 'Artista', 'Artist', 'Genere', 'Genres', 'Stato', 'Status', 'Trama', 'Synopsis', 'Description']) {
      const nextLabels = ['Autore', 'Author', 'Artista', 'Artist', 'Genere', 'Genres', 'Stato', 'Status', 'Trama', 'Synopsis', 'Description']
        .filter((candidate) => candidate !== label)
        .join('|')
      const match = normalized.match(new RegExp(`${label}:?\\s*(.*?)(?=\\s*(?:${nextLabels}):|$)`, 'i'))
      if (match?.[1]) metadata[label] = cleanText(match[1])
    }

    return metadata
  }

  private imageAttr(image: Cheerio<AnyNode>): string {
    return image.attr('src') || image.attr('data-src') || image.attr('data-lazy-src') || ''
  }

  private chapterNumber(title: string, url: string): number {
    const fromUrl = url.match(/\/(\d+(?:\.\d+)?)(?:\/(?:page\/\d+)?)?\/?$/)?.[1]
    const fromTitle = title.match(/(?:chapter|capitolo|cap\.?)\s*(\d+(?:\.\d+)?)/i)?.[1]
    const number = fromTitle || fromUrl
    return number ? Number(number) : 0
  }

  private parseDate(value: string): Date | undefined {
    const clean = value.replace(/^by\s+.*?,\s*/i, '').trim().toLowerCase()
    if (!clean) return undefined

    if (/oggi|today/.test(clean)) return this.startOfDay(0)
    if (/ieri|yesterday/.test(clean)) return this.startOfDay(-1)

    const iso = clean.match(/(\d{4})[.-](\d{1,2})[.-](\d{1,2})/)
    if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))

    const numeric = clean.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/)
    if (numeric) {
      const year = Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3])
      return new Date(year, Number(numeric[2]) - 1, Number(numeric[1]))
    }

    const parsed = Date.parse(clean)
    return Number.isFinite(parsed) ? new Date(parsed) : undefined
  }

  private startOfDay(offsetDays: number): Date {
    const date = new Date()
    date.setHours(0, 0, 0, 0)
    date.setDate(date.getDate() + offsetDays)
    return date
  }

  private normalizeStatus(value: string | undefined): string {
    const normalized = cleanText(value).toLowerCase()
    if (/corso|ongoing|publishing/.test(normalized)) return 'ongoing'
    if (/complet|conclus|finito|finished/.test(normalized)) return 'completed'
    if (/hiatus|pausa|hold/.test(normalized)) return 'hiatus'
    if (/drop|interrott|cancel/.test(normalized)) return 'dropped'
    return 'unknown'
  }

  private titleFromMangaId(mangaId: string): string {
    const slug = mangaId.split('/').filter(Boolean).pop() ?? mangaId
    return decodeURIComponent(slug)
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (character) => character.toUpperCase())
  }

  private contentRating(genres: string[]): ContentRating {
    const normalized = genres.map((genre) => genre.toLowerCase())
    if (normalized.some((genre) => ['hentai', 'adulto', 'adulti', 'smut'].includes(genre))) return ContentRating.ADULT
    if (normalized.some((genre) => ['ecchi', 'horror', 'seinen', 'maturo'].includes(genre))) return ContentRating.MATURE
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
