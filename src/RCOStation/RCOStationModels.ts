import type { Chapter } from '@paperback/types'

export type RCOStationSectionId = 'featured' | 'latest' | 'new' | 'popular'

export interface RCOStationListingConfig {
  id: RCOStationSectionId
  title: string
  heading: string
  includeChapterUpdates: boolean
}

export interface RCOStationListingItem {
  mangaId: string
  title: string
  imageUrl: string
  url: string
  subtitle?: string
  latestChapterId?: string
  latestChapterTitle?: string
}

export interface RCOStationComicData {
  mangaId: string
  title: string
  imageUrl: string
  synopsis: string
  status: string
  publisher?: string
  writer?: string
  artist?: string
  publicationDate?: string
  genres: string[]
  shareUrl: string
  chapters: Chapter[]
  additionalInfo: Record<string, string>
}
