import {
  ContentRating,
  type Chapter,
  type SearchResultItem,
  type SourceManga,
  type TagSection,
} from '@paperback/types'
import * as cheerio from 'cheerio'
import type { Cheerio, CheerioAPI } from 'cheerio'
import type { AnyNode } from 'domhandler'

import { cleanText } from '../common/parsing/html'
import { uniqueBy, uniqueStrings } from '../common/utils/array'
import { orderChaptersForReading } from '../common/utils/chapters'
import { normalizeUrl, pathIdFromUrl } from '../common/utils/url'
import type { RCOStationComicData, RCOStationListingItem } from './RCOStationModels'

const COMIC_HOST_PATTERN = /^https:\/\/(?:www\.)?rcostation\.xyz\//i
const BAD_RESOURCE_PATTERN =
  /(google-analytics|googletagmanager|doubleclick|googlesyndication|googleadservices|adservice\.google|pubadx|weforads|dtscout|amung\.us|hotjar|clarity\.ms|facebook\.net|adnxs|criteo|taboola|outbrain|popads|popcash|propellerads|onclickads|exoclick|juicyads|trafficjunky|mgid|revcontent|21wiz|\/Content\/images\/|user-small|hot\.png|plus\.png|bullet\.png|logo|icon|tracking|tracker|pixel|\.gif(?:[?#]|$))/i

export class RCOStationParser {
  constructor(private readonly baseUrl: string) {}

  parseHomepageSection(html: string, heading: string, currentUrl = this.baseUrl): RCOStationListingItem[] {
    const $ = cheerio.load(html)
    const section = this.sectionByHeading($, heading)
    const root = section.length ? section : $('.item-list').first()
    const items: RCOStationListingItem[] = []

    root.find('.section.group.list').each((_, element) => {
      const item = $(element)
      const anchor = item.find('a[href]').first()
      const rawUrl = normalizeUrl(anchor.attr('href'), currentUrl)
      const title = cleanText(anchor.text()) || cleanText(anchor.attr('title'))

      if (!rawUrl || !title) return

      const issueUrl = this.isValidIssueUrl(rawUrl) ? this.normalizeIssueUrl(rawUrl) : ''
      const comicUrl = this.comicUrlFromIssueUrl(rawUrl)
      if (!this.isValidComicUrl(comicUrl)) return

      const date = cleanText(item.find('.sub-col-2, .col-2').first().text())
      const issueTitle = issueUrl ? title : ''
      const displayTitle = this.stripIssueSuffix(title, comicUrl)
      const subtitle = [
        issueTitle || (displayTitle !== title ? title : ''),
        date,
      ].filter(Boolean).join(' - ')

      items.push({
        mangaId: pathIdFromUrl(comicUrl, this.baseUrl),
        title: displayTitle,
        imageUrl: normalizeUrl(this.getImageUrl(item.find('img').first(), currentUrl), currentUrl),
        url: comicUrl,
        subtitle: subtitle || undefined,
        latestChapterId: issueUrl ? pathIdFromUrl(issueUrl, this.baseUrl) : undefined,
        latestChapterTitle: issueTitle || undefined,
      })
    })

    return uniqueBy(items, (item) => item.mangaId)
  }

  parseSearchResults(html: string, currentUrl = this.baseUrl): RCOStationListingItem[] {
    const $ = cheerio.load(html)
    const items: RCOStationListingItem[] = []

    $('.section.group.list').each((_, element) => {
      const item = $(element)
      const anchor = item
        .find('a[href*="/Comic/"]')
        .filter((__, candidate) => this.isValidComicUrl(normalizeUrl($(candidate).attr('href'), currentUrl)))
        .first()
      const comicUrl = normalizeUrl(anchor.attr('href'), currentUrl)
      const title =
        cleanText(item.find('.col.info a[href*="/Comic/"]').first().text()) ||
        cleanText(anchor.attr('title')) ||
        cleanText(anchor.text())

      if (!this.isValidComicUrl(comicUrl) || !title) return

      const latestAnchor = item.find('a[href*="/Issue-"], a[href*="/Full"]').first()
      const latestUrl = this.isValidIssueUrl(normalizeUrl(latestAnchor.attr('href'), currentUrl))
        ? this.normalizeIssueUrl(normalizeUrl(latestAnchor.attr('href'), currentUrl))
        : ''
      const latestTitle = cleanText(latestAnchor.text())

      items.push({
        mangaId: pathIdFromUrl(comicUrl, this.baseUrl),
        title,
        imageUrl: normalizeUrl(this.getImageUrl(item.find('img').first(), currentUrl), currentUrl),
        url: comicUrl,
        subtitle: latestTitle || undefined,
        latestChapterId: latestUrl ? pathIdFromUrl(latestUrl, this.baseUrl) : undefined,
        latestChapterTitle: latestTitle || undefined,
      })
    })

    if (items.length > 0) return uniqueBy(items, (item) => item.mangaId)

    $('a[href*="/Comic/"]').each((_, element) => {
      const anchor = $(element)
      const rawUrl = normalizeUrl(anchor.attr('href'), currentUrl)
      const comicUrl = this.comicUrlFromIssueUrl(rawUrl)
      if (!this.isValidComicUrl(comicUrl)) return

      const title = cleanText(anchor.text()) || this.titleFromComicUrl(comicUrl)
      if (!title) return

      items.push({
        mangaId: pathIdFromUrl(comicUrl, this.baseUrl),
        title,
        imageUrl: normalizeUrl(this.getImageUrl(anchor.closest('.section, li, div').find('img').first(), currentUrl), currentUrl),
        url: comicUrl,
      })
    })

    return uniqueBy(items, (item) => item.mangaId)
  }

  parseComic(html: string, mangaId: string, shareUrl: string): RCOStationComicData {
    const $ = cheerio.load(html)
    const root = $('.main .wrap').first()
    const details = this.sectionByHeading($, '')
      .filter((_, element) => cleanText($(element).find('.heading h3').first().text()) !== 'Issue(s)')
      .first()
    const title =
      cleanText(root.find('.content_top.red .heading h3').first().text()) ||
      this.titleFromDocument($) ||
      this.titleFromComicUrl(shareUrl || mangaId)
    const metadata = this.parseMetadata($)
    const genres = this.parseGenres($)
    const imageUrl = normalizeUrl(
      this.getImageUrl(root.find('.col.cover img').first(), shareUrl),
      shareUrl
    )

    return {
      mangaId,
      title,
      imageUrl,
      synopsis: this.parseDescription($, details.length ? details : root),
      status: this.normalizeStatus(metadata.Status),
      publisher: metadata.Publisher,
      writer: metadata.Writer,
      artist: metadata.Artist,
      publicationDate: metadata['Publication date'],
      genres,
      shareUrl,
      chapters: this.parseIssues($, mangaId, title, imageUrl),
      additionalInfo: metadata,
    }
  }

  parseReaderPages(html: string, currentUrl: string): string[] {
    const $ = cheerio.load(html)
    const pages: string[] = []

    $('#divImage img').each((_, element) => {
      const imageUrl = normalizeUrl(this.getImageUrl($(element), currentUrl), currentUrl)
      if (this.isValidReaderImage(imageUrl)) pages.push(imageUrl)
    })

    const directPages = uniqueStrings(pages)
    if (directPages.length > 0) return directPages

    const fallbackPages: string[] = []
    $(
      '.content.space-top img[src*="bp.blogspot.com"], img[src*="blogspot.com"], img[src*="blogger.googleusercontent.com"]'
    ).each((_, element) => {
      const imageUrl = normalizeUrl(this.getImageUrl($(element), currentUrl), currentUrl)
      if (this.isValidReaderImage(imageUrl)) fallbackPages.push(imageUrl)
    })

    const selectorPages = uniqueStrings(fallbackPages)
    if (selectorPages.length > 0) return selectorPages

    return this.parseInlineReaderImageUrls(html)
  }

  normalizeIssueUrl(rawUrl: string, server = '', quality = 'hq'): string {
    const normalized = normalizeUrl(rawUrl, this.baseUrl)
    if (!normalized) return ''

    return this.withQueryParams(normalized, {
      s: server,
      quality,
    })
  }

  serverIssueUrl(rawUrl: string, server: string, quality: string): string {
    return this.withQueryParams(normalizeUrl(rawUrl, this.baseUrl), {
      s: server,
      quality,
    })
  }

  toSourceManga(data: RCOStationComicData): SourceManga {
    return {
      mangaId: data.mangaId,
      mangaInfo: {
        primaryTitle: data.title,
        secondaryTitles: [],
        thumbnailUrl: data.imageUrl,
        synopsis: data.synopsis,
        contentRating: this.contentRatingForGenres(data.genres),
        author: data.writer,
        artist: data.artist,
        status: data.status,
        tagGroups: this.toTagGroups(data.genres),
        shareUrl: data.shareUrl,
        additionalInfo: data.additionalInfo,
      },
    }
  }

  toSearchResult(item: RCOStationListingItem): SearchResultItem {
    return {
      mangaId: item.mangaId,
      title: item.title,
      subtitle: item.subtitle,
      imageUrl: item.imageUrl,
      contentRating: ContentRating.MATURE,
    }
  }

  contentRatingForGenres(genres: string[]): ContentRating {
    const normalized = genres.map((genre) => genre.toLowerCase())
    if (normalized.some((genre) => ['adult', 'hentai', 'smut'].includes(genre))) {
      return ContentRating.ADULT
    }

    return ContentRating.MATURE
  }

  private parseIssues(
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
    const issueSection = this.sectionByHeading($, 'Issue(s)')
    const chapters: Chapter[] = []

    issueSection.find('ul.list li').each((index, element) => {
      const item = $(element)
      const anchor = item.find('.col-1 a[href], a[href]').first()
      const issueUrl = this.normalizeIssueUrl(normalizeUrl(anchor.attr('href'), this.baseUrl))
      const title = cleanText(anchor.text()) || cleanText(anchor.find('span').first().text()) || 'Full'

      if (!this.isValidIssueUrl(issueUrl) || !title) return

      chapters.push({
        chapterId: pathIdFromUrl(issueUrl, this.baseUrl),
        sourceManga,
        langCode: 'en',
        chapNum: this.parseIssueNumber(title),
        title,
        publishDate: this.parseDate(cleanText(item.find('.col-2, time').first().text())),
        sortingIndex: index,
        additionalInfo: {
          url: issueUrl,
        },
      })
    })

    return orderChaptersForReading(uniqueBy(chapters, (chapter) => chapter.chapterId))
  }

  private sectionByHeading($: CheerioAPI, heading: string): Cheerio<AnyNode> {
    const normalizedHeading = heading.toLowerCase()

    return $('.content').filter((_, element) => {
      const title = cleanText($(element).find('.heading h3').first().text()).toLowerCase()
      return normalizedHeading ? title === normalizedHeading : Boolean(title)
    })
  }

  private parseMetadata($: CheerioAPI): Record<string, string> {
    const metadata: Record<string, string> = {}

    $('.col.info p').each((_, element) => {
      const row = $(element)
      const label = cleanText(row.find('span').first().text()).replace(/:$/, '')
      if (!label) return

      const valueRow = row.clone()
      valueRow.find('span').first().remove()
      metadata[label] = cleanText(valueRow.text())
    })

    return metadata
  }

  private parseGenres($: CheerioAPI): string[] {
    const genres: string[] = []
    $('.col.info p').each((_, element) => {
      const row = $(element)
      const label = cleanText(row.find('span').first().text()).replace(/:$/, '')
      if (!/^Genres$/i.test(label)) return

      row.find('a[href*="/Genre/"]').each((__, anchor) => {
        const genre = cleanText($(anchor).text())
        if (genre) genres.push(genre)
      })
    })

    return uniqueStrings(genres)
  }

  private parseDescription($: CheerioAPI, root: Cheerio<AnyNode>): string {
    const sections = root.find('.section.group')
    const candidates: string[] = []

    sections.each((_, element) => {
      const section = $(element).clone()
      if (section.find('.col.cover, .col.info, ul.list').length > 0) return

      section.find('script, style, iframe, ins').remove()
      const text = cleanText(section.text())
      if (text && !/^(Issue\(s\)|Related Link\(s\)|Comments?|Bookmark)/i.test(text)) candidates.push(text)
    })

    return candidates[0] ?? ''
  }

  private parseInlineReaderImageUrls(html: string): string[] {
    const decodedHtml = this.decodeHtmlEntities(html)
    const protectedImages = this.parseProtectedReaderImageUrls(decodedHtml)
    if (protectedImages.length > 0) return protectedImages

    const images: string[] = []

    for (const match of decodedHtml.matchAll(/https?:\\?\/\\?\/[^"'<>\s]+(?:bp\.blogspot\.com|blogspot\.com|blogger\.googleusercontent\.com)[^"'<>\s]+/gi)) {
      const imageUrl = match[0].replace(/\\\//g, '/').replace(/;$/, '')
      if (this.isValidReaderImage(imageUrl)) images.push(imageUrl)
    }

    return uniqueStrings(images)
  }

  private parseProtectedReaderImageUrls(html: string): string[] {
    const images: string[] = []

    for (const match of html.matchAll(/pth\s*=\s*(['"])([\s\S]*?)\1\s*;/g)) {
      const imageUrl = this.decodeProtectedBlogspotPath(match[2] ?? '')
      if (this.isValidReaderImage(imageUrl)) images.push(imageUrl)
    }

    return uniqueStrings(images)
  }

  private decodeProtectedBlogspotPath(rawPath: string): string {
    try {
      let protectedPath = rawPath
        .replace(/\\\//g, '/')
        .replace(/Q3__swREYT_/g, 'g')
        .replace(/pw_\.g28x/g, 'b')
        .replace(/d2pr\.x_27/g, 'h')

      if (/^https?:\/\//i.test(protectedPath)) return protectedPath

      const queryIndex = protectedPath.indexOf('?')
      const query = queryIndex >= 0 ? protectedPath.slice(queryIndex) : ''
      const sizeMarker = protectedPath.indexOf('=s0?') >= 0 ? '=s0?' : '=s1600?'
      const markerIndex = protectedPath.indexOf(sizeMarker)
      if (markerIndex <= 0) return ''

      const requestedSize = sizeMarker.startsWith('=s0') ? '=s0' : '=s1600'
      let token = protectedPath.slice(0, markerIndex)
      token = token.slice(15, 33) + token.slice(50)
      token = token.slice(0, token.length - 11) + token[token.length - 2] + token[token.length - 1]

      let decodedPath = this.decodeBase64(token)
      if (!decodedPath) return ''

      decodedPath = decodedPath.slice(0, 13) + decodedPath.slice(17)
      decodedPath = decodedPath.slice(0, decodedPath.length - 2) + requestedSize

      return `https://2.bp.blogspot.com/${decodedPath}${query}`
    } catch {
      return ''
    }
  }

  private decodeBase64(value: string): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const bytes: number[] = []
    let buffer = 0
    let bits = 0

    for (const character of value.replace(/-/g, '+').replace(/_/g, '/')) {
      if (character === '=') break

      const index = alphabet.indexOf(character)
      if (index < 0) continue

      buffer = (buffer << 6) | index
      bits += 6

      if (bits >= 8) {
        bits -= 8
        bytes.push((buffer >> bits) & 0xff)
      }
    }

    return String.fromCharCode(...bytes)
  }

  private stripIssueSuffix(title: string, comicUrl: string): string {
    const stripped = cleanText(
      title
        .replace(/\s+Issue\s*#?\s*\d+(?:\.\d+)?\s*$/i, '')
        .replace(/\s+#\d+(?:\.\d+)?\s*$/i, '')
        .replace(/\s+Full(?:\s*\([^)]*\))?\s*$/i, '')
    )

    return stripped || this.titleFromComicUrl(comicUrl)
  }

  private comicUrlFromIssueUrl(rawUrl: string): string {
    const normalized = normalizeUrl(rawUrl, this.baseUrl)
    if (!normalized) return ''

    const origin = normalized.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i)?.[0] ?? ''
    const path = this.pathFromUrl(normalized)
    const comicPath = path.replace(/\/(?:Issue-[^/?#]+|Full)\/?$/i, '')

    return origin ? `${origin}${comicPath}` : comicPath
  }

  private isValidComicUrl(url: string): boolean {
    if (!COMIC_HOST_PATTERN.test(url)) return false

    const path = this.pathFromUrl(url)
    if (!/^\/Comic\/[^/?#]+\/?$/i.test(path)) return false
    if (/\/(?:Issue-[^/?#]+|Full)\/?$/i.test(path)) return false

    return !/(\/Login|\/Register|\/Genre\/|\/Publisher\/|\/Writer\/|\/Artist\/|\/Message\/)/i.test(path)
  }

  private isValidIssueUrl(url: string): boolean {
    if (!COMIC_HOST_PATTERN.test(url)) return false

    const path = this.pathFromUrl(url)
    const query = this.queryFromUrl(url)
    return /^\/Comic\/[^/?#]+\/(?:Issue-[^/?#]+|Full)\/?$/i.test(path) && /(?:^|&)id=/.test(query)
  }

  private getImageUrl(image: Cheerio<AnyNode>, currentUrl: string): string {
    const raw =
      image.attr('src') ||
      image.attr('data-src') ||
      image.attr('data-lazy-src') ||
      image.attr('data-original') ||
      ''

    return normalizeUrl(this.decodeHtmlEntities(raw), currentUrl)
  }

  private isValidReaderImage(url: string): boolean {
    if (!url || BAD_RESOURCE_PATTERN.test(url)) return false

    const host = this.hostFromUrl(url)
    return (
      host.includes('bp.blogspot.com') ||
      host.includes('blogspot.com') ||
      host.includes('blogger.googleusercontent.com')
    )
  }

  private parseDate(value: string): Date | undefined {
    const match = cleanText(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
    if (!match) return undefined

    return new Date(Number(match[3]), Number(match[1]) - 1, Number(match[2]))
  }

  private parseIssueNumber(value: string): number {
    const issue = value.match(/Issue\s*#?\s*(\d+(?:\.\d+)?)/i)?.[1] || value.match(/#\s*(\d+(?:\.\d+)?)/)?.[1]
    return issue ? Number(issue) : 0
  }

  private normalizeStatus(value: string | undefined): string {
    const normalized = cleanText(value).toLowerCase()
    if (/completed|complete/.test(normalized)) return 'completed'
    if (/ongoing/.test(normalized)) return 'ongoing'

    return 'unknown'
  }

  private titleFromDocument($: CheerioAPI): string {
    return cleanText(
      $('title')
        .first()
        .text()
        .replace(/\s+comic\s+\|\s+Read[\s\S]*$/i, '')
        .replace(/\s+comic online in high quality[\s\S]*$/i, '')
    )
  }

  private titleFromComicUrl(url: string): string {
    const slug = this.pathFromUrl(normalizeUrl(url, this.baseUrl)).match(/\/Comic\/([^/?#]+)/i)?.[1] ?? ''
    return decodeURIComponent(slug)
      .replace(/-/g, ' ')
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

  private withQueryParams(url: string, values: Record<string, string>): string {
    const hashIndex = url.indexOf('#')
    const hash = hashIndex >= 0 ? url.slice(hashIndex) : ''
    const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url
    const queryIndex = withoutHash.indexOf('?')
    const base = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash
    const query = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : ''
    const skipKeys = new Set(Object.keys(values).map((key) => key.toLowerCase()))
    const parts = query
      .split('&')
      .filter((part) => part && !skipKeys.has(part.split('=')[0]?.toLowerCase() ?? ''))

    for (const [key, value] of Object.entries(values)) {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    }

    return `${base}?${parts.join('&')}${hash}`
  }

  private hostFromUrl(url: string): string {
    return url.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i)?.[1]?.toLowerCase() ?? ''
  }

  private pathFromUrl(url: string): string {
    const origin = url.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i)?.[0] ?? ''
    const withoutOrigin = origin ? url.slice(origin.length) : url
    const path = withoutOrigin.split(/[?#]/)[0] ?? ''

    return path.startsWith('/') ? path : `/${path}`
  }

  private queryFromUrl(url: string): string {
    const queryIndex = url.indexOf('?')
    if (queryIndex < 0) return ''

    const hashIndex = url.indexOf('#', queryIndex)
    return hashIndex >= 0 ? url.slice(queryIndex + 1, hashIndex) : url.slice(queryIndex + 1)
  }

  private decodeHtmlEntities(value: string): string {
    return value
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
  }
}
