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
import type { AnimeGDRClubListingItem, AnimeGDRClubMangaData } from './AnimeGDRClubModels'

export class AnimeGDRClubParser {
  constructor(private readonly baseUrl: string) {}

  parsePopular(html: string, currentUrl: string): AnimeGDRClubListingItem[] {
    const $ = cheerio.load(html)
    const items: AnimeGDRClubListingItem[] = []

    $('div.manga').each((_, element) => {
      const root = $(element)
      const anchor = root.find('a.linkalmanga[href]').first()
      const url = normalizeUrl(anchor.attr('href'), currentUrl)
      const title = cleanText(root.find('div.nomeserie > span').first().text()) ||
        cleanText(root.text())
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

  parseLatest(html: string, currentUrl: string): AnimeGDRClubListingItem[] {
    const $ = cheerio.load(html)
    const items: AnimeGDRClubListingItem[] = []

    $('.containernews > a[href]').each((_, element) => {
      const root = $(element)
      const chapterUrl = normalizeUrl(root.attr('href'), currentUrl)
      const title = cleanText(root.find('.titolo').first().text()) ||
        cleanText(root.text()).replace(/\d{2}-\d{2}-\d{4}.*$/i, '')
      if (!chapterUrl || !title) return

      const mangaId = this.mangaIdFromReaderUrl(chapterUrl)
      items.push({
        mangaId,
        title,
        imageUrl: normalizeUrl(this.imageAttr(root.find('img').first()), currentUrl),
        url: normalizeUrl(mangaId, this.baseUrl),
        latestChapterId: pathIdFromUrl(chapterUrl, this.baseUrl),
        latestChapterTitle: this.latestChapterTitle(root),
        latestChapterDate: this.parseDate(cleanText(root.text())),
      })
    })

    return uniqueBy(items, (item) => `${item.mangaId}:${item.latestChapterId ?? ''}`)
  }

  parseManga(html: string, mangaId: string, shareUrl: string): AnimeGDRClubMangaData {
    const $ = cheerio.load(html)
    const info = $('.tabellaalta').first()
    const metadata = this.metadata($, info)
    const title =
      metadata.Titolo ||
      cleanText($('title').first().text().replace(/\s*AGC Reader\s*/i, '')) ||
      this.titleFromMangaId(mangaId)
    const genres = uniqueStrings(info.find('span.generi > a').map((_, element) => cleanText($(element).text())).get())
    const imageUrl = normalizeUrl(this.imageAttr(info.find('.immagine img, img').first()), shareUrl)

    return {
      mangaId,
      title,
      imageUrl,
      synopsis: cleanText(info.find('span.trama').first().text()).replace(/^Trama:\s*/i, ''),
      genres,
      status: this.normalizeStatus(cleanText(info.text())),
      shareUrl,
      chapters: this.parseChapters($, mangaId, title, imageUrl),
      additionalInfo: metadata,
    }
  }

  parseChapterPages(html: string, currentUrl: string): string[] {
    const $ = cheerio.load(html)
    const slug = cleanText($('#nomemanga').first().attr('class'))
    const chapterNumber = cleanText($('.numcap').first().text())
    const maxPage = Number(cleanText($('.maxpag').first().text()))
    if (slug && chapterNumber && Number.isFinite(maxPage) && maxPage > 0) {
      return Array.from({ length: maxPage }, (_, index) =>
        normalizeUrl(`${slug}/cap.${chapterNumber}/${index + 1}.jpg`, this.baseUrl)
      )
    }

    const pages: string[] = []
    $('img.corrente').each((_, element) => {
      const url = normalizeUrl(this.imageAttr($(element)), currentUrl)
      if (url) pages.push(url)
    })

    return uniqueStrings(pages)
  }

  toSourceManga(data: AnimeGDRClubMangaData): SourceManga {
    return {
      mangaId: data.mangaId,
      mangaInfo: {
        primaryTitle: data.title,
        secondaryTitles: [],
        thumbnailUrl: data.imageUrl,
        synopsis: data.synopsis,
        contentRating: this.contentRating(data.genres),
        status: data.status,
        tagGroups: this.toTagGroups(data.genres),
        shareUrl: data.shareUrl,
        additionalInfo: data.additionalInfo,
      },
    }
  }

  toSearchResult(item: AnimeGDRClubListingItem): SearchResultItem {
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

    $('.capitoli_cont > a[href]').each((index, element) => {
      const anchor = $(element)
      const chapterUrl = normalizeUrl(anchor.attr('href'), this.baseUrl)
      const title = cleanText(anchor.text())
      if (!chapterUrl || !title) return

      chapters.push({
        chapterId: pathIdFromUrl(chapterUrl, this.baseUrl),
        sourceManga,
        langCode: 'it',
        chapNum: this.chapterNumber(title, chapterUrl),
        title,
        sortingIndex: index,
        additionalInfo: {
          url: chapterUrl,
        },
      })
    })

    return orderChaptersForReading(uniqueBy(chapters, (chapter) => chapter.chapterId))
  }

  private metadata($: CheerioAPI, root: Cheerio<AnyNode>): Record<string, string> {
    const text = cleanText(root.text())
    const metadata: Record<string, string> = {}
    for (const label of ['Titolo', 'Generi', 'Stato', 'Aggiornato il', 'Trama']) {
      const match = text.match(new RegExp(`${label}:\\s*(.*?)(?=\\s*(?:Titolo|Generi|Stato|Aggiornato il|Trama):|$)`, 'i'))
      if (match?.[1]) metadata[label] = cleanText(match[1])
    }

    return metadata
  }

  private mangaIdFromReaderUrl(chapterUrl: string): string {
    const name = chapterUrl.match(/[?&]nome=([^&#]+)/i)?.[1]
    return name ? `/progetto.php?nome=${decodeURIComponent(name)}` : pathIdFromUrl(chapterUrl, this.baseUrl)
  }

  private latestChapterTitle(root: Cheerio<AnyNode>): string | undefined {
    const text = cleanText(root.text())
    return text.match(/(Capitolo\s+[^ ]+)/i)?.[1] || undefined
  }

  private parseDate(value: string): Date | undefined {
    const match = value.match(/(\d{1,2})-(\d{1,2})-(\d{4})/)
    if (!match) return undefined
    return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]))
  }

  private imageAttr(image: Cheerio<AnyNode>): string {
    return image.attr('src') || image.attr('data-src') || ''
  }

  private chapterNumber(title: string, url: string): number {
    const query = url.match(/[?&]numcap=([^&#]+)/i)?.[1]
    const text = title.match(/Capitolo\s+(\d+(?:\.\d+)?)/i)?.[1]
    const number = text || query
    return number ? Number(number) : 0
  }

  private normalizeStatus(value: string): string {
    const normalized = value.toLowerCase()
    if (/in corso/.test(normalized)) return 'ongoing'
    if (/conclus|finito/.test(normalized)) return 'completed'
    if (/interrott/.test(normalized)) return 'hiatus'
    return 'unknown'
  }

  private titleFromMangaId(mangaId: string): string {
    const name = mangaId.match(/[?&]nome=([^&#]+)/i)?.[1] ?? mangaId.split('/').pop() ?? mangaId
    return decodeURIComponent(name).replace(/[-_]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase())
  }

  private contentRating(genres: string[]): ContentRating {
    const normalized = genres.map((genre) => genre.toLowerCase())
    if (normalized.some((genre) => ['ecchi', 'horror', 'seinen'].includes(genre))) return ContentRating.MATURE
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
