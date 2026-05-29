import type { Chapter } from '@paperback/types'

export type ZeurelScanSectionId = 'featured' | 'latest' | 'series'

export interface ZeurelScanListingConfig {
  id: ZeurelScanSectionId
  title: string
  path: string
  includeChapterUpdates: boolean
}

export interface ZeurelScanListingItem {
  mangaId: string
  title: string
  imageUrl: string
  url: string
  latestChapterId?: string
  latestChapterTitle?: string
}

export interface ZeurelScanMangaData {
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
