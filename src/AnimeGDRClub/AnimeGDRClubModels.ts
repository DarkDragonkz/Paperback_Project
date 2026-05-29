import type { Chapter } from '@paperback/types'

export interface AnimeGDRClubListingItem {
  mangaId: string
  title: string
  imageUrl: string
  url: string
  latestChapterId?: string
  latestChapterTitle?: string
  latestChapterDate?: Date
}

export interface AnimeGDRClubMangaData {
  mangaId: string
  title: string
  imageUrl: string
  synopsis: string
  genres: string[]
  status: string
  shareUrl: string
  chapters: Chapter[]
  additionalInfo: Record<string, string>
}
