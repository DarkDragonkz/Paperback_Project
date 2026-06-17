import type { Chapter } from '@paperback/types'

export type NiaddSectionId = 'latest' | 'popular' | 'original' | 'today'

export interface NiaddListingConfig {
  id: NiaddSectionId
  title: string
  url: string
  includeChapterUpdates: boolean
  featured: boolean
}

export interface NiaddListingItem {
  mangaId: string
  title: string
  imageUrl: string
  url: string
  latestChapterId?: string
  latestChapterTitle?: string
  latestDate?: string
}

export interface NiaddMangaData {
  mangaId: string
  title: string
  imageUrl: string
  status?: string
  synopsis: string
  genres: string[]
  shareUrl: string
  chapters: Chapter[]
  additionalInfo: Record<string, string>
}
