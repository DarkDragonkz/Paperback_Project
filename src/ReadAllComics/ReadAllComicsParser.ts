import { ContentRating, type Chapter, type SearchResultItem, type SourceManga, type TagSection } from '@paperback/types'
import * as cheerio from 'cheerio'
import type { Cheerio, CheerioAPI } from 'cheerio'
import type { AnyNode } from 'domhandler'

import { cleanText, safeAttr, safeText, splitCommaList } from '../common/parsing/html'
import { uniqueBy, uniqueStrings } from '../common/utils/array'
import { normalizeUrl, pathIdFromUrl } from '../common/utils/url'
import type { ReadAllComicsListingItem, ReadAllComicsMangaData } from './ReadAllComicsModels'

const IGNORED_IMAGE_HOSTS = new Set([
  'platform.pubadx.one',
  'weforads.com',
  'static.addtoany.com',
  'pagead2.googlesyndication.com',
  'highperformanceformat.com',
  'protrafficinspector.com',
  'kettledroopingcontinuation.com',
  'spendsdetachment.com',
  'realizationnewestfangs.com',
  'dtscout.com',
  'whos.amung.us',
  'mrktmtrcs.net',
  'revantage.io',
  'bidmatic.io',
  'rbstsystems.live',
  '4dex.io',
  'imp9.pubadx.one',
  'uploadfiles.revwala.com',
])

const BAD_IMAGE_PATTERN =
  /(logo|avatar|ads?|advert|banner|tracking|tracker|pixel|blank|spacer|icon|sprite|preloader|loader|captcha|analytics|addtoany|counter|button|emoji|wp-content\/plugins|googleads|doubleclick|dtscout|whos\.amung\.us|pubadx)/i
const ISSUE_URL_PATTERN = /^https:\/\/readallcomics\.com\/(?!category\/|page\/|tag\/|author\/|wp-)[^/?#]+\/?$/i

export class ReadAllComicsParser {
  constructor(private readonly baseUrl: string) {}

  parseCatalogItems(html: string): ReadAllComicsListingItem[] {
    const $ = cheerio.load(html)
    const items: ReadAllComicsListingItem[] = []

    $('ul.list-story.categories > li').each((_, element) => {
      const item = $(element)
      const titleAnchor = item.find('a.cat-title[href], a.cat-title').first()
      const linkAnchor = item.find('a.cat-title[href], a.book-link[href]').first()
      const mangaUrl = normalizeUrl(linkAnchor.attr('href'), this.baseUrl)
      const title = cleanText(titleAnchor.text()) || cleanText(titleAnchor.attr('title'))

      if (!mangaUrl || !title) return

      const latestAnchor = item.find('a.latest-chapter[href]').first()
      const latestUrl = normalizeUrl(latestAnchor.attr('href'), this.baseUrl)
      const latestTitle = cleanText(latestAnchor.text())
      const latestDate = this.stripLabel(safeText($, '.latest-date', item), 'Updated')
      const issueSummary = cleanText(
        safeText($, '.cat-total-issues', item)
          .replace(safeText($, '.cat-vol', item), '')
          .replace(safeText($, '.issue-count', item), '')
      ) || safeText($, '.cat-total-issues', item)

      items.push({
        mangaId: pathIdFromUrl(mangaUrl, this.baseUrl),
        title,
        imageUrl: normalizeUrl(
          safeAttr($, 'img.book-cover', 'src', item) ||
            safeAttr($, 'img.book-cover', 'data-src', item) ||
            safeAttr($, 'img.book-cover', 'data-lazy-src', item) ||
            safeAttr($, 'img.book-cover', 'data-original', item),
          this.baseUrl
        ),
        url: mangaUrl,
        publisher: this.stripLabel(safeText($, '.cat-publisher', item), 'Publisher'),
        genres: this.parseGenres(this.stripLabel(safeText($, '.cat-genres', item), 'Genres')),
        issueSummary,
        latestChapterId: latestUrl ? pathIdFromUrl(latestUrl, this.baseUrl) : undefined,
        latestChapterTitle: latestTitle,
        latestDate,
      })
    })

    return uniqueBy(items, (item) => item.mangaId)
  }

  parseAjaxSearchResults(html: string): ReadAllComicsListingItem[] {
    const normalizedHtml = this.ajaxHtmlPayload(html)
    const catalogItems = this.parseCatalogItems(normalizedHtml)
    if (catalogItems.length > 0) return catalogItems

    const $ = cheerio.load(normalizedHtml)
    const items: ReadAllComicsListingItem[] = []

    $('a[href*="/category/"]').each((_, element) => {
      const anchor = $(element)
      const mangaUrl = normalizeUrl(anchor.attr('href'), this.baseUrl)
      const title = cleanText(anchor.text()) || cleanText(anchor.attr('title'))

      if (!mangaUrl || !title) return

      const row = anchor.closest('li, article, div')
      const image = row.find('img').first()

      items.push({
        mangaId: pathIdFromUrl(mangaUrl, this.baseUrl),
        title,
        imageUrl: normalizeUrl(this.firstImageAttribute(image), this.baseUrl),
        url: mangaUrl,
        genres: [],
      })
    })

    return uniqueBy(items, (item) => item.mangaId)
  }

  parseManga(html: string, mangaId: string, shareUrl: string): ReadAllComicsMangaData {
    const $ = cheerio.load(html)
    const catalogItem = this.parseCatalogItems(html)[0]
    const root = $('.description-archive').first()
    const title =
      safeText($, 'h1', root.length ? root : undefined) ||
      this.titleFromDocument($) ||
      catalogItem?.title ||
      this.titleFromMangaId(mangaId)
    const metadata = this.parseMetadata($, root)
    const publisher = metadata.Publisher || catalogItem?.publisher
    const genres = uniqueStrings([
      ...this.parseGenres(metadata.Genres ?? ''),
      ...(catalogItem?.genres ?? []),
    ])
    const imageUrl =
      normalizeUrl(
        this.firstImageAttribute(root.find('img').first()) ||
          safeAttr($, '.entry-content img', 'src') ||
          catalogItem?.imageUrl,
        this.baseUrl
      )
    const issueSummary = metadata.Year || metadata.Issues || catalogItem?.issueSummary

    return {
      mangaId,
      title,
      imageUrl,
      publisher,
      synopsis: this.parseSynopsis($),
      genres,
      issueSummary,
      shareUrl,
      chapters: this.parseChapters($, mangaId, title, imageUrl),
      additionalInfo: metadata,
    }
  }

  parseIssueImages(html: string, currentUrl: string): string[] {
    const $ = cheerio.load(html)
    const images: string[] = []

    const selectors = [
      '.index-wrapper img',
      '.index-wrapper center img',
      'center img',
      'img[src*="blogger.googleusercontent.com"]',
      'img[src*="bp.blogspot.com"]',
      'img[src*="blogspot.com"]',
      'img[data-src*="blogger.googleusercontent.com"]',
      'img[data-lazy-src*="blogger.googleusercontent.com"]',
      'img[data-original*="blogger.googleusercontent.com"]',
    ]

    for (const selector of selectors) {
      $(selector).each((_, element) => {
        const image = $(element)
        for (const imageUrl of this.imageUrlsFromAttributes(image, currentUrl)) {
          if (this.isComicPageImage(imageUrl, image)) images.push(imageUrl)
        }
      })
    }

    return uniqueStrings(images)
  }

  toSourceManga(data: ReadAllComicsMangaData): SourceManga {
    return {
      mangaId: data.mangaId,
      mangaInfo: {
        primaryTitle: data.title,
        secondaryTitles: [],
        thumbnailUrl: data.imageUrl,
        synopsis: data.synopsis,
        contentRating: ContentRating.MATURE,
        author: data.publisher,
        artist: data.publisher,
        status: undefined,
        tagGroups: this.toTagGroups(data.genres),
        shareUrl: data.shareUrl,
        additionalInfo: data.additionalInfo,
      },
    }
  }

  toSearchResult(item: ReadAllComicsListingItem): SearchResultItem {
    return {
      mangaId: item.mangaId,
      title: item.title,
      subtitle: this.subtitleForItem(item),
      imageUrl: item.imageUrl,
      contentRating: ContentRating.MATURE,
    }
  }

  subtitleForItem(item: ReadAllComicsListingItem): string | undefined {
    return [item.latestChapterTitle, item.latestDate].filter(Boolean).join(' - ') ||
      item.issueSummary ||
      item.publisher
  }

  parseWpAjaxConfig(html: string): { nonce: string; ajaxUrl: string } {
    const match = html.match(/var\s+htps\s*=\s*(\{.*?\});/s)
    if (!match?.[1]) return { nonce: '', ajaxUrl: '' }

    try {
      const data = JSON.parse(match[1]) as { ajax_url?: unknown; nonce?: unknown }
      return {
        nonce: typeof data.nonce === 'string' ? data.nonce : '',
        ajaxUrl: typeof data.ajax_url === 'string' ? data.ajax_url : '',
      }
    } catch {
      return {
        nonce: match[1].match(/["']nonce["']\s*:\s*["']([^"']+)["']/)?.[1] ?? '',
        ajaxUrl: match[1].match(/["']ajax_url["']\s*:\s*["']([^"']+)["']/)?.[1] ?? '',
      }
    }
  }

  parseWpAjaxNonce(html: string): string {
    return this.parseWpAjaxConfig(html).nonce
  }

  private parseChapters(
    $: CheerioAPI,
    mangaId: string,
    mangaTitle: string,
    thumbnailUrl: string
  ): Chapter[] {
    const sourceManga: SourceManga = {
      mangaId,
      mangaInfo: {
        primaryTitle: mangaTitle,
        secondaryTitles: [],
        thumbnailUrl,
        synopsis: '',
        contentRating: ContentRating.MATURE,
      },
    }
    const chapters: Chapter[] = []

    this.issueAnchors($).each((index, element) => {
      const anchor = $(element)
      const issueUrl = normalizeUrl(anchor.attr('href'), this.baseUrl)
      const title = cleanText(anchor.text()) || this.titleFromIssueUrl(issueUrl)
      if (!this.isIssueUrl(issueUrl) || !title) return

      const row = anchor.closest('li, article, div')
      const dateText =
        cleanText(row.find('time[datetime]').first().attr('datetime')) ||
        this.stripLabel(safeText($, '.latest-date, .post-date, .date, time', row), 'Updated')

      chapters.push({
        chapterId: pathIdFromUrl(issueUrl, this.baseUrl),
        sourceManga,
        langCode: 'en',
        chapNum: this.parseChapterNumber(title || issueUrl),
        title,
        volume: this.parseVolume(title || issueUrl),
        publishDate: this.parseDate(dateText),
        sortingIndex: index,
        additionalInfo: {
          url: issueUrl,
        },
      })
    })

    return uniqueBy(chapters, (chapter) => chapter.chapterId)
  }

  private issueAnchors($: CheerioAPI): Cheerio<AnyNode> {
    const anchors = $(
      [
        'ul.list-story li a[href]',
        '.entry-content a[href]',
        'article a[href]',
        '.post a[href]',
      ].join(',')
    )

    return anchors.filter((_, element) => this.isIssueUrl(normalizeUrl($(element).attr('href'), this.baseUrl)))
  }

  private parseMetadata($: CheerioAPI, root?: Cheerio<AnyNode>): Record<string, string> {
    const metadata: Record<string, string> = {}
    const scope = root?.length ? root : $('.description-archive, .cat-info, .entry-content, article')

    const candidates = [
      ...scope.find('p, div').toArray(),
      ...scope.toArray(),
    ]

    for (const element of candidates) {
      const text = cleanText($(element).text())
      for (const label of ['Publisher', 'Genres', 'Year', 'Issues']) {
        const value = this.valueAfterLabel(text, label)
        if (value && !metadata[label]) metadata[label] = value
      }
    }

    return metadata
  }

  private parseSynopsis($: CheerioAPI): string {
    const root = $('.description-archive').first()
    const body = root.find('.b').first()
    const description = (body.length ? body : root.length ? root : $('.entry-content, article').first()).clone()
    description.find('img, script, style, .group-box, ul.list-story, .list-story, .addtoany_share_save_container').remove()

    const rows = description
      .text()
      .split(/\n+/)
      .map((row) => cleanText(row))
      .filter((row) => row && !this.isNoiseDescriptionRow(row))

    return rows.join('\n').trim()
  }

  private parseGenres(value: string): string[] {
    return splitCommaList(value.replace(/^Genres:\s*/i, ''))
  }

  private imageUrlsFromAttributes(image: Cheerio<AnyNode>, currentUrl: string): string[] {
    const images: string[] = []
    const attributes = [
      'src',
      'data-src',
      'data-lazy-src',
      'data-original',
      'data-jh-lazy-img',
      'srcset',
      'data-srcset',
    ]

    for (const attribute of attributes) {
      for (const imageUrl of this.imageUrlsFromValue(image.attr(attribute), currentUrl)) {
        images.push(imageUrl)
      }
    }

    return images
  }

  private imageUrlsFromValue(value: string | undefined, currentUrl: string): string[] {
    if (!value) return []

    const decodedValue = this.decodeHtmlEntities(value)
    const srcsetParts = decodedValue.includes(',') ? decodedValue.split(',') : [decodedValue]
    const images: string[] = []

    for (const part of srcsetParts) {
      const candidate = part.trim().split(/\s+/)[0]
      const normalized = normalizeUrl(candidate, currentUrl || this.baseUrl)
      if (normalized && !normalized.startsWith('data:')) images.push(normalized)
    }

    return images
  }

  private firstImageAttribute(image: Cheerio<AnyNode>): string {
    return (
      image.attr('src') ||
      image.attr('data-src') ||
      image.attr('data-lazy-src') ||
      image.attr('data-original') ||
      image.attr('data-jh-lazy-img') ||
      ''
    )
  }

  private isComicPageImage(url: string, image: Cheerio<AnyNode>): boolean {
    const normalized = url.toLowerCase()
    if (!normalized || normalized.startsWith('data:')) return false
    if (BAD_IMAGE_PATTERN.test(normalized)) return false

    const host = this.hostFromUrl(normalized)
    if (IGNORED_IMAGE_HOSTS.has(host)) return false
    if (!this.isReaderImageHost(host)) return false

    const className = cleanText(image.attr('class'))
    const alt = cleanText(image.attr('alt'))
    const id = cleanText(image.attr('id'))
    if (BAD_IMAGE_PATTERN.test(`${className} ${alt} ${id}`)) return false

    const width = this.numberAttribute(image, 'width')
    const height = this.numberAttribute(image, 'height')
    if ((width > 0 && width < 120) || (height > 0 && height < 120)) return false

    return true
  }

  private isReaderImageHost(host: string): boolean {
    return (
      host === 'blogger.googleusercontent.com' ||
      host.endsWith('.blogger.googleusercontent.com') ||
      host === 'bp.blogspot.com' ||
      host.endsWith('.bp.blogspot.com') ||
      host === 'blogspot.com' ||
      host.endsWith('.blogspot.com')
    )
  }

  private numberAttribute(image: Cheerio<AnyNode>, attribute: string): number {
    const value = image.attr(attribute)?.match(/\d+/)?.[0]
    return value ? Number(value) : 0
  }

  private isIssueUrl(url: string): boolean {
    return ISSUE_URL_PATTERN.test(url)
  }

  private stripLabel(value: string, label: string): string {
    return cleanText(value.replace(new RegExp(`^${label}:\\s*`, 'i'), ''))
  }

  private valueAfterLabel(text: string, label: string): string {
    const match = text.match(
      new RegExp(`${label}:\\s*([^\\n|]+?)(?=\\s+(?:Publisher|Genres|Year|Issues):|\\s+Vol\\s+\\d+:|\\s+Issue List|$)`, 'i')
    )
    return cleanText(match?.[1])
  }

  private titleFromDocument($: CheerioAPI): string {
    const rawTitle = safeText($, 'title')
    return cleanText(
      rawTitle
        .replace(/^Read\s+/i, '')
        .replace(/\s+Comic Book Online Free.*$/i, '')
        .replace(/\s+\|\s+Read All Comics Online.*$/i, '')
    )
  }

  private isNoiseDescriptionRow(row: string): boolean {
    if (/^(Publisher|Genres|Year|Issues):/i.test(row)) return true
    if (/^(Issue List|Facebook|Reddit|X|Copy Link|Share)$/i.test(row)) return true
    return /\b(Facebook|Reddit|Copy Link|Share)\b/i.test(row) && row.length < 80
  }

  private parseChapterNumber(value: string): number {
    const matches = [...value.matchAll(/(?:#|^|[-\s])(\d+(?:\.\d+)?)(?=\D|$)/g)]
    const issue = matches
      .map((match) => Number(match[1]))
      .find((candidate) => Number.isFinite(candidate) && candidate > 0 && candidate < 1900)

    return issue ?? 0
  }

  private parseVolume(value: string): number | undefined {
    const volume = value.match(/\bv(?:ol(?:ume)?\.?\s*)?(\d+)\b/i)?.[1]
    return volume ? Number(volume) : undefined
  }

  private parseDate(value: string): Date | undefined {
    if (!value) return undefined

    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? undefined : date
  }

  private titleFromMangaId(mangaId: string): string {
    const slug = mangaId.match(/\/category\/([^/]+)/)?.[1] ?? mangaId
    return this.titleFromSlug(slug)
  }

  private titleFromIssueUrl(url: string): string {
    const slug = url.match(/\/([^/?#]+)\/?$/)?.[1] ?? ''
    return this.titleFromSlug(slug)
  }

  private titleFromSlug(slug: string): string {
    return decodeURIComponent(slug)
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (character) => character.toUpperCase())
  }

  private toTagGroups(genres: string[]): TagSection[] {
    const tags = uniqueStrings(genres).map((genre) => ({
      id: genre.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      title: genre,
    }))

    return tags.length > 0 ? [{ id: 'genres', title: 'Genres', tags }] : []
  }

  private ajaxHtmlPayload(html: string): string {
    try {
      const payload = JSON.parse(html) as { data?: unknown; html?: unknown }
      if (typeof payload.data === 'string') return payload.data
      if (typeof payload.html === 'string') return payload.html
    } catch {
      return html
    }

    return html
  }

  private hostFromUrl(url: string): string {
    return url.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i)?.[1]?.toLowerCase() ?? ''
  }

  private decodeHtmlEntities(value: string): string {
    return value
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&apos;/g, "'")
  }
}
