import type { Chapter } from '@paperback/types'

export type ReadAllComicsSectionId = 'featured' | 'latest' | 'catalog'

export interface ReadAllComicsListingConfig {
  id: ReadAllComicsSectionId
  title: string
  includeChapterUpdates: boolean
}

export interface ReadAllComicsListingItem {
  mangaId: string
  title: string
  imageUrl: string
  url: string
  publisher?: string
  genres: string[]
  issueSummary?: string
  latestChapterId?: string
  latestChapterTitle?: string
  latestDate?: string
}

export interface ReadAllComicsMangaData {
  mangaId: string
  title: string
  imageUrl: string
  publisher?: string
  synopsis: string
  genres: string[]
  issueSummary?: string
  shareUrl: string
  chapters: Chapter[]
  additionalInfo: Record<string, string>
}
