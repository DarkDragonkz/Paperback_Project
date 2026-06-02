import type { Chapter } from '@paperback/types'

export type XoxoComicsSectionId = 'trending' | 'latest' | 'new' | 'popular'

export interface XoxoComicsListingConfig {
  id: XoxoComicsSectionId
  title: string
  url: string
  itemSelector: string
  includeChapterUpdates: boolean
  featured: boolean
}

export interface XoxoComicsListingItem {
  mangaId: string
  title: string
  imageUrl: string
  url: string
  genres: string[]
  latestChapterId?: string
  latestChapterTitle?: string
  latestDate?: string
}

export interface XoxoComicsMangaData {
  mangaId: string
  title: string
  imageUrl: string
  author?: string
  artist?: string
  status?: string
  synopsis: string
  genres: string[]
  shareUrl: string
  chapters: Chapter[]
  additionalInfo: Record<string, string>
}
