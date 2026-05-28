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
import { normalizeUrl, pathIdFromUrl } from '../common/utils/url'
import type { MangaWorldListingItem, MangaWorldMangaData } from './MangaWorldModels'

const MANGA_HOST_PATTERN = /^https:\/\/(?:www\.)?mangaworld\.mx\//i
const CDN_HOST = 'cdn.mangaworld.mx'
const IGNORED_URL_PATTERN =
  /(platform\.pubadx\.one|googletagmanager|google-analytics|googlesyndication|doubleclick|pubadx|weforads|dtscout|amung\.us|hotjar|clarity\.ms|facebook\.net|adservice\.google|googleadservices|adnxs|criteo|taboola|outbrain|popads|popcash|propellerads|onclickads|exoclick|juicyads|trafficjunky|mgid|revcontent|logo|placeholder|icon|sprite|tracker|pixel)/i

export class MangaWorldParser {
  constructor(private readonly baseUrl: string) {}

  parseMangaTiles(html: string, currentUrl = this.baseUrl): MangaWorldListingItem[] {
    const $ = cheerio.load(html)
    const items: MangaWorldListingItem[] = []

    $('.comics-grid .entry').each((_, element) => {
      const item = $(element)
      const anchor = item
        .find('a[href*="/manga/"]')
        .filter((__, candidate) => this.isValidMangaUrl(normalizeUrl($(candidate).attr('href'), currentUrl)))
        .first()
      const mangaUrl = normalizeUrl(anchor.attr('href'), currentUrl)
      const title =
        cleanText(item.find('.name').first().text()) ||
        cleanText(item.find('.title').first().text()) ||
        cleanText(anchor.attr('title')) ||
        cleanText(anchor.text())

      if (!mangaUrl || !title) return

      const latestAnchor = item
        .find('a[href*="/read/"]')
        .filter((__, candidate) => this.isValidChapterUrl(normalizeUrl($(candidate).attr('href'), currentUrl)))
        .first()
      const latestUrl = this.normalizeReaderUrl(normalizeUrl(latestAnchor.attr('href'), currentUrl))

      items.push({
        mangaId: pathIdFromUrl(mangaUrl, this.baseUrl),
        title,
        imageUrl: normalizeUrl(this.getImageUrl(item.find('img').first(), currentUrl), currentUrl),
        url: mangaUrl,
        subtitle: this.tileSubtitle($, item),
        genres: this.tileGenres($, item),
        latestChapterId: latestUrl ? pathIdFromUrl(latestUrl, this.baseUrl) : undefined,
        latestChapterTitle: this.chapterTitleFromAnchor(latestAnchor),
      })
    })

    return uniqueBy(items, (item) => item.mangaId)
  }

  parseManga(html: string, mangaId: string, shareUrl: string): MangaWorldMangaData {
    const $ = cheerio.load(html)
    const metadata = this.parseMetadata($)
    const title =
      cleanText($('.single-comic h1.name, h1.name, h1').first().text()) ||
      this.titleFromDocument($) ||
      this.titleFromMangaId(mangaId)
    const genres = this.parseGenres($, metadata)
    const imageUrl = normalizeUrl(
      this.getImageUrl(
        $(
          '.single-comic .comic-info img[src*="cdn.mangaworld.mx/mangas/"], .comic-info img[src*="cdn.mangaworld.mx/mangas/"], .single-comic img[alt*="Scan ITA"], img[alt*="Scan ITA"]'
        ).first(),
        shareUrl
      ),
      shareUrl
    )

    return {
      mangaId,
      title,
      imageUrl,
      synopsis: this.parseSynopsis($),
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
    const selectors = [
      '#reader img',
      '.reader img',
      '.chapter-reader img',
      'main img[src*="cdn.mangaworld.mx/chapters/"]',
      'img[src*="cdn.mangaworld.mx/chapters/"]',
      'img[data-src*="cdn.mangaworld.mx/chapters/"]',
      'img[data-lazy-src*="cdn.mangaworld.mx/chapters/"]',
      'img[data-original*="cdn.mangaworld.mx/chapters/"]',
    ]

    for (const selector of selectors) {
      const pages: string[] = []

      $(selector).each((_, element) => {
        const imageUrl = normalizeUrl(this.getImageUrl($(element), currentUrl), currentUrl)
        if (this.isValidReaderImage(imageUrl)) pages.push(imageUrl)
      })

      const uniquePages = uniqueStrings(pages)
      if (uniquePages.length > 0) return uniquePages
    }

    return []
  }

  parseNextPageUrl(html: string, currentUrl: string): string | undefined {
    const $ = cheerio.load(html)
    const directNext =
      $('a[rel="next"][href]').first().attr('href') ||
      $('.pagination a[href]')
        .filter((_, element) => /successiv|next/i.test(cleanText($(element).attr('aria-label'))))
        .first()
        .attr('href')
    const normalizedDirectNext = normalizeUrl(directNext, currentUrl)
    if (normalizedDirectNext) return normalizedDirectNext

    const textNext = $('.pagination a[href]')
      .filter((_, element) => /^(?:next|successiva|›|»|>)$/i.test(cleanText($(element).text())))
      .first()
      .attr('href')

    return normalizeUrl(textNext, currentUrl) || undefined
  }

  normalizeReaderUrl(rawUrl: string): string {
    const normalized = normalizeUrl(rawUrl, this.baseUrl)
    if (!normalized) return ''

    const hashIndex = normalized.indexOf('#')
    const hash = hashIndex >= 0 ? normalized.slice(hashIndex) : ''
    const withoutHash = hashIndex >= 0 ? normalized.slice(0, hashIndex) : normalized
    const queryIndex = withoutHash.indexOf('?')
    const basePath = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash
    const query = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : ''
    const readerPath = basePath.replace(/(\/read\/[^/?#]+)(?:\/\d+)?\/?$/i, '$1/1')
    const queryParts = query
      .split('&')
      .filter((part) => part && !/^style=/i.test(part))

    queryParts.push('style=list')

    return `${readerPath}?${queryParts.join('&')}${hash}`
  }

  toSourceManga(data: MangaWorldMangaData): SourceManga {
    return {
      mangaId: data.mangaId,
      mangaInfo: {
        primaryTitle: data.title,
        secondaryTitles: [],
        thumbnailUrl: data.imageUrl,
        synopsis: data.synopsis,
        contentRating: this.contentRatingForGenres(data.genres),
        author: data.author,
        artist: data.artist,
        status: data.status,
        tagGroups: this.toTagGroups(data.genres),
        shareUrl: data.shareUrl,
        additionalInfo: data.additionalInfo,
      },
    }
  }

  toSearchResult(item: MangaWorldListingItem): SearchResultItem {
    return {
      mangaId: item.mangaId,
      title: item.title,
      subtitle: item.subtitle,
      imageUrl: item.imageUrl,
      contentRating: this.contentRatingForGenres(item.genres),
    }
  }

  contentRatingForGenres(genres: string[]): ContentRating {
    const normalized = genres.map((genre) => genre.toLowerCase())
    if (normalized.some((genre) => ['adulti', 'hentai', 'lolicon', 'shotacon', 'smut', 'yaoi', 'yuri'].includes(genre))) {
      return ContentRating.ADULT
    }

    if (normalized.some((genre) => ['ecchi', 'maturo', 'seinen'].includes(genre))) {
      return ContentRating.MATURE
    }

    return ContentRating.EVERYONE
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

    $('.chapter').each((index, element) => {
      const item = $(element)
      const anchor = item
        .find('a[href*="/read/"]')
        .filter((_, candidate) => this.isValidChapterUrl(normalizeUrl($(candidate).attr('href'), this.baseUrl)))
        .first()
      const chapterUrl = this.normalizeReaderUrl(normalizeUrl(anchor.attr('href'), this.baseUrl))
      const title = this.chapterTitleFromAnchor(anchor) || this.titleFromChapterUrl(chapterUrl)

      if (!chapterUrl || !title) return

      chapters.push({
        chapterId: pathIdFromUrl(chapterUrl, this.baseUrl),
        sourceManga,
        langCode: 'it',
        chapNum: this.parseChapterNumber(title),
        title,
        volume: this.parseVolumeNumber(item),
        publishDate: this.parseItalianDate(cleanText(item.find('.chap-date, time').first().text())),
        sortingIndex: index,
        additionalInfo: {
          url: chapterUrl,
        },
      })
    })

    return uniqueBy(chapters, (chapter) => chapter.chapterId)
      .reverse()
      .map((chapter, index) => ({
        ...chapter,
        sortingIndex: index,
      }))
  }

  private parseMetadata($: CheerioAPI): Record<string, string> {
    const metadata: Record<string, string> = {}

    $('.single-comic .meta-data [class*="col-"], .comic-info .meta-data [class*="col-"]').each((_, element) => {
      const row = $(element)
      const label = cleanText(row.find('.font-weight-bold, b, strong').first().text()).replace(/:$/, '')
      if (!label) return

      const valueRow = row.clone()
      valueRow.find('.font-weight-bold, b, strong').first().remove()
      metadata[label] = cleanText(valueRow.text())
    })

    return metadata
  }

  private parseGenres($: CheerioAPI, metadata: Record<string, string>): string[] {
    const genres: string[] = []

    $('.single-comic .meta-data [class*="col-"], .comic-info .meta-data [class*="col-"]').each((_, element) => {
      const row = $(element)
      const label = cleanText(row.find('.font-weight-bold, b, strong').first().text()).replace(/:$/, '')
      if (!/^Generi$/i.test(label)) return

      row.find('a[href*="genre="]').each((__, anchor) => {
        const genre = cleanText($(anchor).text())
        if (genre) genres.push(genre)
      })
    })

    if (genres.length === 0) genres.push(...splitCommaList(metadata.Generi ?? ''))

    return uniqueStrings(genres)
  }

  private parseSynopsis($: CheerioAPI): string {
    const description = $('.single-comic .comic-description, .comic-description').first().clone()
    description.find('.heading, script, style, ins, iframe').remove()

    return cleanText(description.text().replace(/^TRAMA\s*/i, ''))
  }

  private tileSubtitle($: CheerioAPI, item: Cheerio<AnyNode>): string | undefined {
    const parts: string[] = []
    for (const label of ['Tipo', 'Stato', 'Data']) {
      const value = this.tileLabelValue($, item, label)
      if (value) parts.push(value)
    }

    const latest = this.chapterTitleFromAnchor(item.find('a[href*="/read/"]').first())
    if (latest) parts.push(latest)

    return parts.length > 0 ? parts.join(' - ') : undefined
  }

  private tileLabelValue($: CheerioAPI, item: Cheerio<AnyNode>, label: string): string {
    const labelElement = item
      .find('.font-weight-bold, b, strong')
      .filter((_, element) => cleanText($(element).text()).replace(/:$/, '').toLowerCase() === label.toLowerCase())
      .first()

    if (!labelElement.length) return ''

    const row = labelElement.parent().clone()
    row.find('.font-weight-bold, b, strong').first().remove()

    return cleanText(row.text())
  }

  private tileGenres($: CheerioAPI, item: Cheerio<AnyNode>): string[] {
    const genres: string[] = []
    item.find('a[href*="genre="]').each((_, anchor) => {
      const genre = cleanText($(anchor).text())
      if (genre) genres.push(genre)
    })

    return uniqueStrings(genres)
  }

  private chapterTitleFromAnchor(anchor: Cheerio<AnyNode>): string {
    const spanText = cleanText(anchor.find('span').first().text())
    const rawTitle = spanText || cleanText(anchor.attr('title')) || cleanText(anchor.text())

    return cleanText(rawTitle.replace(/\s*Scan ITA.*$/i, ''))
  }

  private getImageUrl(image: Cheerio<AnyNode>, currentUrl: string): string {
    const raw =
      image.attr('src') ||
      image.attr('data-src') ||
      image.attr('data-lazy-src') ||
      image.attr('data-original') ||
      ''

    return normalizeUrl(this.decodeHtmlEntities(raw), currentUrl)
  }

  private isValidMangaUrl(url: string): boolean {
    if (!MANGA_HOST_PATTERN.test(url)) return false

    const path = this.pathFromUrl(url)
    if (!/^\/manga\/\d+\/[^/?#]+\/?$/i.test(path)) return false
    if (path.includes('/read/')) return false

    return !/(login|register|privacy|contatti|contact|premium|bookmarks)/i.test(path)
  }

  private isValidChapterUrl(url: string): boolean {
    if (!MANGA_HOST_PATTERN.test(url)) return false

    const path = this.pathFromUrl(url)
    return path.includes('/manga/') && path.includes('/read/')
  }

  private isValidReaderImage(url: string): boolean {
    if (!url || IGNORED_URL_PATTERN.test(url)) return false

    const host = this.hostFromUrl(url)
    const path = this.pathFromUrl(url)

    return host === CDN_HOST && path.includes('/chapters/') && /\.(?:jpe?g|png|webp)$/i.test(path)
  }

  private parseChapterNumber(value: string): number {
    const chapter = value.match(/(?:capitolo|chapter|ch\.?)\s*(\d+(?:\.\d+)?)/i)?.[1]
    if (chapter) return Number(chapter)

    const fallback = value.match(/(\d+(?:\.\d+)?)/)?.[1]
    return fallback ? Number(fallback) : 0
  }

  private parseVolumeNumber(chapter: Cheerio<AnyNode>): number | undefined {
    const volumeText = cleanText(
      chapter
        .closest('.volume-element')
        .find('.volume-name')
        .first()
        .text()
    )
    const volume = volumeText.match(/(?:vol(?:ume)?\.?)\s*(\d+(?:\.\d+)?)/i)?.[1]

    return volume ? Number(volume) : undefined
  }

  private parseItalianDate(value: string): Date | undefined {
    const match = cleanText(value).match(/(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s+(\d{4})/)
    if (!match) return undefined

    const month = this.italianMonth(match[2])
    if (month < 0) return undefined

    return new Date(Number(match[3]), month, Number(match[1]))
  }

  private italianMonth(value: string): number {
    const months: Record<string, number> = {
      gennaio: 0,
      febbraio: 1,
      marzo: 2,
      aprile: 3,
      maggio: 4,
      giugno: 5,
      luglio: 6,
      agosto: 7,
      settembre: 8,
      ottobre: 9,
      novembre: 10,
      dicembre: 11,
    }

    return months[value.toLowerCase()] ?? -1
  }

  private normalizeStatus(value: string | undefined): string {
    const normalized = cleanText(value).toLowerCase()
    if (/in corso|ongoing/.test(normalized)) return 'ongoing'
    if (/complet|completo|finito|completed/.test(normalized)) return 'completed'

    return 'unknown'
  }

  private titleFromDocument($: CheerioAPI): string {
    return cleanText(
      $('title')
        .first()
        .text()
        .replace(/\s+Scan ITA\s+-\s+MangaWorld.*$/i, '')
        .replace(/\s+-\s+MangaWorld.*$/i, '')
    )
  }

  private titleFromMangaId(mangaId: string): string {
    const slug = mangaId.match(/\/manga\/\d+\/([^/?#]+)/)?.[1] ?? mangaId
    return decodeURIComponent(slug)
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (character) => character.toUpperCase())
  }

  private titleFromChapterUrl(url: string): string {
    return url.match(/\/read\/([^/?#]+)/)?.[1] ?? 'Capitolo'
  }

  private toTagGroups(genres: string[]): TagSection[] {
    const tags = uniqueStrings(genres).map((genre) => ({
      id: genre.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      title: genre,
    }))

    return tags.length > 0 ? [{ id: 'genres', title: 'Generi', tags }] : []
  }

  private hostFromUrl(url: string): string {
    return url.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i)?.[1]?.toLowerCase() ?? ''
  }

  private pathFromUrl(url: string): string {
    const origin = url.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i)?.[0] ?? ''
    const withoutOrigin = origin ? url.slice(origin.length) : url
    const path = withoutOrigin.split(/[?#]/)[0] ?? ''

    return path.startsWith('/') ? path : `/${path}`
  }

  private decodeHtmlEntities(value: string): string {
    return value
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&apos;/g, "'")
  }
}
