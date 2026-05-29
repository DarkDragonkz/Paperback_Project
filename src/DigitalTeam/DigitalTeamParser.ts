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
import type { DigitalTeamListingItem, DigitalTeamMangaData, DigitalTeamPageData } from './DigitalTeamModels'

export interface DigitalTeamReaderInfo {
  manga: string
  chapter: string
  subchapter: string
  title: string
  external: boolean
}

export class DigitalTeamParser {
  constructor(private readonly baseUrl: string) {}

  parseSeries(html: string, currentUrl: string): DigitalTeamListingItem[] {
    const $ = cheerio.load(html)
    const items: DigitalTeamListingItem[] = []

    $('ul li.manga_block').each((_, element) => {
      const root = $(element)
      const anchor = root.find('.manga_title a[href]').first()
      const url = normalizeUrl(anchor.attr('href'), currentUrl)
      const title = cleanText(anchor.text())
      if (!url || !title) return

      items.push({
        mangaId: pathIdFromUrl(url, this.baseUrl),
        title,
        imageUrl: normalizeUrl(this.imageAttr(root.find('img').first()), currentUrl),
        url,
      })
    })

    return uniqueBy(items, (item) => item.mangaId)
  }

  parseManga(html: string, mangaId: string, shareUrl: string): DigitalTeamMangaData {
    const $ = cheerio.load(html)
    const info = $('#manga_left').first()
    const metadata = this.metadata($, info)
    const title =
      metadata.Titolo ||
      cleanText($('title').first().text().replace(/^Digital Team\s*-\s*/i, '').replace(/\s*Manga Ita\s*$/i, '')) ||
      this.titleFromMangaId(mangaId)
    const genres = uniqueStrings(splitCommaList(metadata.Genere ?? ''))
    const imageUrl = normalizeUrl(this.imageAttr(info.find('.cover img').first()), shareUrl)

    return {
      mangaId,
      title,
      imageUrl,
      synopsis: cleanText($('div.plot').first().text()),
      author: metadata.Autore,
      artist: metadata.Artista,
      genres,
      status: this.normalizeStatus(metadata.Status),
      shareUrl,
      chapters: this.parseChapters($, mangaId, title, imageUrl),
      additionalInfo: metadata,
    }
  }

  parseReaderInfo(html: string): DigitalTeamReaderInfo {
    const $ = cheerio.load(html)
    const script = $('body').html() ?? html
    const manga = script.match(/(?:^|[,\s])m='([^']+)'/)?.[1] ?? ''
    const chapter = script.match(/(?:^|[,\s])ch='([^']+)'/)?.[1] ?? ''
    const subchapter = script.match(/(?:^|[,\s])chs='([^']*)'/)?.[1] ?? '0'
    const title = cleanText($('title').first().text())
    const external = $('script[src*="jq_rext.js"]').length > 0
    if (!manga || !chapter) throw new Error('DigitalTeam reader metadata not found')

    return {
      manga,
      chapter,
      subchapter,
      title,
      external,
    }
  }

  parseReaderPages(responseText: string, external: boolean): string[] {
    const firstParse = JSON.parse(responseText) as string | unknown[]
    const result = typeof firstParse === 'string'
      ? JSON.parse(firstParse) as unknown[]
      : firstParse
    const imageData = result[0] as DigitalTeamPageData[]

    if (external) {
      const imageBases = result[1] as string[]
      return imageData.map((image, index) => `${imageBases[index] ?? ''}${image.name}${image.ex}`)
    }

    const suffixes = result[1] as string[]
    const basePath = result[2] as string
    return imageData.map((image, index) =>
      normalizeUrl(`/reader${basePath}${image.name}${suffixes[index] ?? ''}${image.ex}`, this.baseUrl)
    )
  }

  toSourceManga(data: DigitalTeamMangaData): SourceManga {
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

  toSearchResult(item: DigitalTeamListingItem): SearchResultItem {
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

    $('.chapter_list ul li').each((index, element) => {
      const row = $(element)
      const anchor = row.find('a[href]').first()
      const chapterUrl = normalizeUrl(anchor.attr('href'), this.baseUrl)
      const title = cleanText(anchor.text())
      if (!chapterUrl || !title) return

      chapters.push({
        chapterId: pathIdFromUrl(chapterUrl, this.baseUrl),
        sourceManga,
        langCode: 'it',
        chapNum: this.chapterNumber(title, chapterUrl),
        title,
        publishDate: this.parseDate(cleanText(row.find('.ch_bottom').first().text()).replace(/^Pubblicato il\s*/i, '')),
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
    root.find('.info_block').each((_, element) => {
      const row = $(element)
      const label = cleanText(row.find('.info_name').first().text()).replace(/:$/, '')
      const value = cleanText(row.find('.info_content').first().text())
      if (label && value) metadata[label] = value
    })

    return metadata
  }

  private imageAttr(image: Cheerio<AnyNode>): string {
    return image.attr('src') || image.attr('data-src') || ''
  }

  private chapterNumber(title: string, url: string): number {
    const fromUrl = url.match(/\/read\/[^/]+\/(\d+(?:\.\d+)?)/i)?.[1]
    const fromTitle = title.match(/Capitolo\s+(\d+(?:\.\d+)?)/i)?.[1]
    const number = fromTitle || fromUrl
    return number ? Number(number) : 0
  }

  private parseDate(value: string): Date | undefined {
    const match = value.match(/(\d{1,2})-(\d{1,2})-(\d{4})/)
    if (!match) return undefined
    return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]))
  }

  private normalizeStatus(value: string | undefined): string {
    const normalized = cleanText(value).toLowerCase()
    if (/in corso/.test(normalized)) return 'ongoing'
    if (/complet/.test(normalized)) return 'completed'
    return 'unknown'
  }

  private titleFromMangaId(mangaId: string): string {
    const slug = mangaId.split('/').filter(Boolean).pop() ?? mangaId
    return decodeURIComponent(slug).replace(/[-_]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase())
  }

  private contentRating(genres: string[]): ContentRating {
    const normalized = genres.map((genre) => genre.toLowerCase())
    if (normalized.some((genre) => ['maturo', 'horror', 'seinen'].includes(genre))) return ContentRating.MATURE
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
