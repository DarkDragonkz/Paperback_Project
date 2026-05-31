import { NINEMANGA_LANGUAGE_CONFIGS, type NineMangaLanguageId } from './NineMangaLanguageConfig'

export function registerNineMangaSettings(): void {
  try {
    const options = Object.values(NINEMANGA_LANGUAGE_CONFIGS).map((cfg) => ({
      label: cfg.label,
      value: cfg.id,
    }))

    const payload = {
      key: 'ninemanga.language',
      title: 'NineManga Language',
      description: 'Select NineManga language/region for the source',
      type: 'select',
      default: 'en' as NineMangaLanguageId,
      options,
    }

    // Try several possible Application APIs that hosts might provide
    // These calls are best-effort and will be no-ops if the API is missing
    // @ts-ignore
    if (typeof Application !== 'undefined') {
      // @ts-ignore
      if (typeof Application.registerSourceSettings === 'function') {
        // @ts-ignore
        Application.registerSourceSettings('ninemanga', [payload])
        return
      }

      // @ts-ignore
      if (typeof Application.registerSettings === 'function') {
        // @ts-ignore
        Application.registerSettings([payload])
        return
      }

      // @ts-ignore
      if (typeof Application.registerSetting === 'function') {
        // @ts-ignore
        Application.registerSetting(payload.key, payload)
        return
      }
    }
  } catch (e) {
    console.log('[NineManga] Could not register settings:', String(e))
  }
}
