import type { Chapter } from '@paperback/types'

export interface PizzaReaderConfig {
  sourceName: string
  baseUrl: string
  language: string
  requestDelayMs?: number
}

export type PizzaReaderSectionId = 'featured' | 'popular' | 'latest'

export interface PizzaReaderListingConfig {
  id: PizzaReaderSectionId
  title: string
  includeChapterUpdates: boolean
}

export interface PizzaReaderComicListResponse {
  comics?: PizzaReaderComic[]
}

export interface PizzaReaderComicResponse {
  comic?: PizzaReaderComic
}

export interface PizzaReaderChapterResponse {
  comic?: PizzaReaderComic
  chapter?: PizzaReaderChapter
}

export interface PizzaReaderComic {
  title?: string
  thumbnail?: string
  thumbnail_small?: string
  description?: string
  alt_titles?: string[]
  author?: string
  artist?: string
  target?: string
  genres?: PizzaReaderGenre[]
  status?: string
  adult?: number | boolean
  url?: string
  slug?: string
  recommended?: number
  last_chapter?: PizzaReaderChapter | null
  chapters?: PizzaReaderChapter[]
}

export interface PizzaReaderGenre {
  name?: string
  slug?: string
}

export interface PizzaReaderTeam {
  name?: string
  url?: string
}

export interface PizzaReaderChapter {
  full_title?: string
  title?: string
  volume?: number | null
  chapter?: number | null
  subchapter?: number | null
  full_chapter?: string
  language?: string
  teams?: Array<PizzaReaderTeam | null>
  updated_at?: string
  published_on?: string
  url?: string
  pages?: string[]
}

export interface PizzaReaderMangaData {
  mangaId: string
  title: string
  imageUrl: string
  synopsis: string
  status: string
  author?: string
  artist?: string
  genres: string[]
  altTitles: string[]
  contentRatingAdult: boolean
  shareUrl: string
  chapters: Chapter[]
  additionalInfo: Record<string, string>
}
