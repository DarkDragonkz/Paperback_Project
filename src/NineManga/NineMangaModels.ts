import type { Chapter } from '@paperback/types'

export type NineMangaSectionId = 'latest' | 'hot' | 'new' | 'completed' | 'updated'

export interface NineMangaListingConfig {
  id: NineMangaSectionId
  title: string
  path: string
  ajaxPrefix: string
  includeChapterUpdates: boolean
}

export interface NineMangaListingItem {
  mangaId: string
  title: string
  imageUrl: string
  url: string
  genres: string[]
  latestChapterId?: string
  latestChapterTitle?: string
}

export interface NineMangaMangaData {
  mangaId: string
  title: string
  imageUrl: string
  author?: string
  artist?: string
  status?: string
  synopsis: string
  genres: string[]
  shareUrl: string
  isAdult: boolean
  bookId?: string
  warningUrl?: string
  chapters: Chapter[]
  additionalInfo: Record<string, string>
}

export interface NineMangaChapterPage {
  url: string
  imageUrl?: string
}

export type NineMangaMobileSearchItem = [
  imageUrl?: string,
  title?: string,
  url?: string,
  unknown?: string,
  author?: string,
]
