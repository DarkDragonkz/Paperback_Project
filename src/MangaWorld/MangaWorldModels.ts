import type { Chapter } from '@paperback/types'

export type MangaWorldSectionId = 'featured' | 'latest' | 'popular' | 'new' | 'completed' | 'genres'

export interface MangaWorldListingConfig {
  id: MangaWorldSectionId
  title: string
  path: string
  includeChapterUpdates: boolean
}

export interface MangaWorldListingItem {
  mangaId: string
  title: string
  imageUrl: string
  url: string
  subtitle?: string
  genres: string[]
  latestChapterId?: string
  latestChapterTitle?: string
}

export interface MangaWorldMangaData {
  mangaId: string
  title: string
  imageUrl: string
  synopsis: string
  status: string
  author?: string
  artist?: string
  genres: string[]
  shareUrl: string
  chapters: Chapter[]
  additionalInfo: Record<string, string>
}

export interface MangaWorldPageMetadata {
  [key: string]: string | undefined
  nextUrl?: string
}
