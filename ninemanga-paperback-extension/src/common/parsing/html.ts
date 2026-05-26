import type { Cheerio, CheerioAPI } from 'cheerio'
import type { AnyNode } from 'domhandler'

type NodeSelection = Cheerio<AnyNode>

export function cleanText(value: string | undefined | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

export function safeText($: CheerioAPI, selector: string, root?: NodeSelection): string {
  const selection = root ? root.find(selector).first() : $(selector).first()
  return cleanText(selection.text())
}

export function safeAttr(
  $: CheerioAPI,
  selector: string,
  attribute: string,
  root?: NodeSelection
): string | undefined {
  const selection = root ? root.find(selector).first() : $(selector).first()
  const value = selection.attr(attribute)
  return value ? cleanText(value) : undefined
}

export function splitCommaList(value: string): string[] {
  return value
    .split(',')
    .map((item) => cleanText(item))
    .filter(Boolean)
}
