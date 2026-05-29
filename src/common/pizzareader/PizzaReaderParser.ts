import {
  ContentRating,
  type Chapter,
  type SearchResultItem,
  type SourceManga,
  type TagSection,
} from '@paperback/types'

import { uniqueBy, uniqueStrings } from '../utils/array'
import { orderChaptersForReading } from '../utils/chapters'
import { normalizeUrl } from '../utils/url'
import type {
  PizzaReaderChapter,
  PizzaReaderComic,
  PizzaReaderConfig,
  PizzaReaderMangaData,
} from './PizzaReaderModels'

export class PizzaReaderParser {
  constructor(private readonly config: PizzaReaderConfig) {}

  toSourceManga(comic: PizzaReaderComic): SourceManga {
    return this.toSourceMangaData(comic).sourceManga
  }

  toSourceMangaData(comic: PizzaReaderComic): {
    sourceManga: SourceManga
    data: PizzaReaderMangaData
  } {
    const data = this.toMangaData(comic)

    return {
      data,
      sourceManga: {
        mangaId: data.mangaId,
        mangaInfo: {
          primaryTitle: data.title,
          secondaryTitles: data.altTitles,
          thumbnailUrl: data.imageUrl,
          synopsis: data.synopsis,
          contentRating: this.contentRatingForComic(comic),
          author: data.author,
          artist: data.artist,
          status: data.status,
          tagGroups: this.toTagGroups(data.genres),
          shareUrl: data.shareUrl,
          additionalInfo: data.additionalInfo,
        },
      },
    }
  }

  toMangaData(comic: PizzaReaderComic): PizzaReaderMangaData {
    const mangaId = this.mangaId(comic)
    const title = this.cleanText(comic.title) || this.titleFromMangaId(mangaId)
    const genres = this.genres(comic)
    const imageUrl = normalizeUrl(comic.thumbnail || comic.thumbnail_small, this.config.baseUrl)
    const sourceManga: SourceManga = {
      mangaId,
      mangaInfo: {
        primaryTitle: title,
        secondaryTitles: [],
        thumbnailUrl: imageUrl,
        synopsis: '',
        contentRating: this.contentRatingForComic(comic),
      },
    }

    return {
      mangaId,
      title,
      imageUrl,
      synopsis: this.cleanText(comic.description),
      status: this.normalizeStatus(comic.status),
      author: this.cleanText(comic.author),
      artist: this.cleanText(comic.artist),
      genres,
      altTitles: uniqueStrings((comic.alt_titles ?? []).map((title) => this.cleanText(title)).filter(Boolean)),
      contentRatingAdult: this.isAdult(comic),
      shareUrl: normalizeUrl(mangaId, this.config.baseUrl),
      chapters: this.toChapters(comic.chapters ?? [], sourceManga),
      additionalInfo: {
        target: this.cleanText(comic.target),
        statusText: this.cleanText(comic.status),
      },
    }
  }

  toSearchResult(comic: PizzaReaderComic): SearchResultItem {
    return {
      mangaId: this.mangaId(comic),
      title: this.cleanText(comic.title) || this.titleFromMangaId(this.mangaId(comic)),
      subtitle: this.subtitleForComic(comic),
      imageUrl: normalizeUrl(comic.thumbnail || comic.thumbnail_small, this.config.baseUrl),
      contentRating: this.contentRatingForComic(comic),
    }
  }

  toChapters(chapters: PizzaReaderChapter[], sourceManga: SourceManga): Chapter[] {
    const parsed = chapters
      .map((chapter, index) => this.toChapter(chapter, sourceManga, index))
      .filter((chapter): chapter is Chapter => Boolean(chapter))

    return orderChaptersForReading(uniqueBy(parsed, (chapter) => chapter.chapterId))
  }

  chapterPages(chapter: PizzaReaderChapter | undefined): string[] {
    return uniqueStrings(
      (chapter?.pages ?? [])
        .map((page) => normalizeUrl(page, this.config.baseUrl))
        .filter((page) => /^https?:\/\//i.test(page))
    )
  }

  sortLatest(comics: PizzaReaderComic[]): PizzaReaderComic[] {
    return [...comics]
      .filter((comic) => comic.last_chapter)
      .sort((left, right) => {
        const leftTime = this.dateTime(left.last_chapter?.published_on || left.last_chapter?.updated_at)
        const rightTime = this.dateTime(right.last_chapter?.published_on || right.last_chapter?.updated_at)
        return rightTime - leftTime
      })
  }

  contentRatingForComic(comic: PizzaReaderComic): ContentRating {
    if (this.isAdult(comic)) return ContentRating.ADULT

    const normalized = this.genres(comic).map((genre) => genre.toLowerCase())
    if (normalized.some((genre) => ['hentai', 'adulto', 'adulti', 'smut'].includes(genre))) {
      return ContentRating.ADULT
    }

    if (normalized.some((genre) => ['ecchi', 'seinen', 'splatter', 'horror'].includes(genre))) {
      return ContentRating.MATURE
    }

    return ContentRating.EVERYONE
  }

  subtitleForComic(comic: PizzaReaderComic): string | undefined {
    const parts = [
      this.cleanText(comic.status),
      this.cleanText(comic.last_chapter?.full_title || comic.last_chapter?.full_chapter),
    ].filter(Boolean)

    return parts.length > 0 ? parts.join(' - ') : undefined
  }

  private toChapter(
    chapter: PizzaReaderChapter,
    sourceManga: SourceManga,
    sortingIndex: number
  ): Chapter | undefined {
    const chapterId = this.cleanPath(chapter.url)
    if (!chapterId) return undefined

    const chapNum = this.chapterNumber(chapter)
    const subchapter = typeof chapter.subchapter === 'number' ? chapter.subchapter : undefined

    return {
      chapterId,
      sourceManga,
      langCode: this.cleanText(chapter.language) || this.config.language,
      chapNum,
      title: this.cleanText(chapter.full_title || chapter.title || chapter.full_chapter) || `Capitolo ${chapNum}`,
      volume: typeof chapter.volume === 'number' ? chapter.volume : undefined,
      version: this.scanlator(chapter),
      publishDate: this.parseDate(chapter.published_on || chapter.updated_at),
      sortingIndex,
      additionalInfo: {
        url: chapterId,
        subchapter: subchapter === undefined ? '' : String(subchapter),
      },
    }
  }

  private chapterNumber(chapter: PizzaReaderChapter): number {
    const base = typeof chapter.chapter === 'number' ? chapter.chapter : 0
    const subchapter = typeof chapter.subchapter === 'number' ? chapter.subchapter : 0
    if (subchapter <= 0) return base

    return Number(`${base}.${subchapter}`)
  }

  private scanlator(chapter: PizzaReaderChapter): string | undefined {
    const teams = uniqueStrings(
      (chapter.teams ?? [])
        .map((team) => this.cleanText(team?.name))
        .filter(Boolean)
    )

    return teams.length > 0 ? teams.join(' & ') : undefined
  }

  private mangaId(comic: PizzaReaderComic): string {
    return this.cleanPath(comic.url) || (comic.slug ? `/comics/${comic.slug}` : '')
  }

  private cleanPath(value: string | undefined): string {
    const clean = this.cleanText(value)
    if (!clean) return ''

    const normalized = normalizeUrl(clean, this.config.baseUrl)
    const origin = this.config.baseUrl.replace(/\/+$/, '')
    if (normalized.startsWith(origin)) return normalized.slice(origin.length) || '/'

    return clean.startsWith('/') ? clean : `/${clean}`
  }

  private genres(comic: PizzaReaderComic): string[] {
    return uniqueStrings([
      ...((comic.genres ?? []).map((genre) => this.cleanText(genre.name)).filter(Boolean)),
      this.cleanText(comic.target),
    ].filter(Boolean))
  }

  private toTagGroups(genres: string[]): TagSection[] {
    const tags = uniqueStrings(genres).map((genre) => ({
      id: genre.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      title: genre,
    }))

    return tags.length > 0 ? [{ id: 'genres', title: 'Generi', tags }] : []
  }

  private normalizeStatus(value: string | undefined): string {
    const normalized = this.cleanText(value).toLowerCase()
    if (/in corso|on going|ongoing/.test(normalized)) return 'ongoing'
    if (/complet|conclus|finito/.test(normalized)) return 'completed'
    if (/pausa|hiatus/.test(normalized)) return 'hiatus'
    if (/dropp|cancell|interrott/.test(normalized)) return 'abandoned'

    return 'unknown'
  }

  private isAdult(comic: PizzaReaderComic): boolean {
    return comic.adult === true || comic.adult === 1
  }

  private parseDate(value: string | undefined): Date | undefined {
    const time = this.dateTime(value)
    return time > 0 ? new Date(time) : undefined
  }

  private dateTime(value: string | undefined): number {
    const clean = this.cleanText(value)
    if (!clean) return 0

    const normalized = clean.replace(/\.(\d{3})\d+(Z|[+-]\d\d:\d\d)$/i, '.$1$2')
    const time = Date.parse(normalized)
    return Number.isFinite(time) ? time : 0
  }

  private titleFromMangaId(mangaId: string): string {
    const slug = mangaId.split('/').filter(Boolean).pop() ?? mangaId
    return decodeURIComponent(slug)
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (character) => character.toUpperCase())
  }

  private cleanText(value: string | undefined | null): string {
    return String(value ?? '').replace(/\s+/g, ' ').trim()
  }
}
