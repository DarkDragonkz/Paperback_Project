import type { Chapter } from '@paperback/types'

export interface FoolSlideConfig {
  sourceKey: string
  sourceName: string
  baseUrl: string
  urlModifier?: string
  language: string
  supportsLatest?: boolean
  popularUsesLatest?: boolean
  directorySelector?: string
  chapterListSelector?: string
  requestDelayMs?: number
}

export interface FoolSlideListingItem {
  mangaId: string
  title: string
  url: string
  imageUrl: string
  latestChapterId?: string
  latestChapterTitle?: string
  latestChapterDate?: Date
}

export interface FoolSlideMangaData {
  mangaId: string
  title: string
  imageUrl: string
  synopsis: string
  author?: string
  artist?: string
  genres: string[]
  status: string
  shareUrl: string
  chapters: Chapter[]
  additionalInfo: Record<string, string>
}
