import type { Chapter } from '@paperback/types'

export interface DigitalTeamListingItem {
  mangaId: string
  title: string
  imageUrl: string
  url: string
}

export interface DigitalTeamMangaData {
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

export interface DigitalTeamPageData {
  name: string
  ex: string
}
