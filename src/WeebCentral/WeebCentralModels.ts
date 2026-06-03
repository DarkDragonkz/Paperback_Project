import type { Chapter } from '@paperback/types'

export type WeebCentralSectionId = 'hot' | 'recent'

export interface WeebCentralListingConfig {
  id: WeebCentralSectionId
  title: string
  url: string
  paged: boolean
}

export interface WeebCentralListingItem {
  mangaId: string
  title: string
  imageUrl: string
  url: string
}

export interface WeebCentralMangaData {
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
