import type { Chapter } from '@paperback/types'

export function orderChaptersForReading<T extends Chapter>(chapters: T[]): T[] {
  const ordered = shouldReverseForReading(chapters) ? [...chapters].reverse() : [...chapters]

  return ordered.map((chapter, index) => ({
    ...chapter,
    sortingIndex: index,
  }))
}

function shouldReverseForReading(chapters: Chapter[]): boolean {
  const numberedChapters = chapters.filter(
    (chapter) => Number.isFinite(chapter.chapNum) && chapter.chapNum > 0
  )

  if (numberedChapters.length < 2) return false

  const first = numberedChapters[0]?.chapNum ?? 0
  const last = numberedChapters[numberedChapters.length - 1]?.chapNum ?? 0

  return first > last
}
