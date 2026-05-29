import type { Chapter } from '@paperback/types'

export type NineMangaSectionId = 'featured' | 'latest' | 'popular'

export interface NineMangaListingConfig {
  id: NineMangaSectionId
  title: string
  path: string
  includeChapterUpdates: boolean
}

export interface NineMangaListingPage {
  items: NineMangaListingItem[]
  nextUrl?: string
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

export interface NineMangaChapterPageResult {
  pages: NineMangaChapterPage[]
  nextUrl?: string
}

export interface NineMangaPageMetadata {
  [key: string]: string | undefined
  nextUrl?: string
}
