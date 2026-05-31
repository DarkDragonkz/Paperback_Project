export type NineMangaLanguageId = 'en' | 'es' | 'ru' | 'it' | 'de' | 'br' | 'fr'

export interface NineMangaLanguageConfig {
  id: NineMangaLanguageId
  label: string
  baseUrl: string
  cookieDomain: string
  langCode: string
  flowType: 'english-finance-gate' | 'localized-tascabile'
}

export const NINEMANGA_LANGUAGE_CONFIGS: Record<NineMangaLanguageId, NineMangaLanguageConfig> = {
  en: {
    id: 'en',
    label: 'English',
    baseUrl: 'https://www.ninemanga.com/',
    cookieDomain: 'ninemanga.com',
    langCode: 'en',
    flowType: 'english-finance-gate',
  },
  es: {
    id: 'es',
    label: 'Español',
    baseUrl: 'https://es.ninemanga.com/',
    cookieDomain: 'es.ninemanga.com',
    langCode: 'es',
    flowType: 'english-finance-gate',
  },
  ru: {
    id: 'ru',
    label: 'Русский',
    baseUrl: 'https://ru.ninemanga.com/',
    cookieDomain: 'ru.ninemanga.com',
    langCode: 'ru',
    flowType: 'english-finance-gate',
  },
  it: {
    id: 'it',
    label: 'Italiano',
    baseUrl: 'https://it.ninemanga.com/',
    cookieDomain: 'it.ninemanga.com',
    langCode: 'it',
    flowType: 'localized-tascabile',
  },
  de: {
    id: 'de',
    label: 'Deutsch',
    baseUrl: 'https://de.ninemanga.com/',
    cookieDomain: 'de.ninemanga.com',
    langCode: 'de',
    flowType: 'localized-tascabile',
  },
  br: {
    id: 'br',
    label: 'Português (Brasil)',
    baseUrl: 'https://br.ninemanga.com/',
    cookieDomain: 'br.ninemanga.com',
    langCode: 'pt-BR',
    flowType: 'localized-tascabile',
  },
  fr: {
    id: 'fr',
    label: 'Français',
    baseUrl: 'https://fr.ninemanga.com/',
    cookieDomain: 'fr.ninemanga.com',
    langCode: 'fr',
    flowType: 'localized-tascabile',
  },
}

export function getNineMangaLanguageConfig(id: NineMangaLanguageId) {
  return NINEMANGA_LANGUAGE_CONFIGS[id]
}
