import { Form, LabelRow, Section, SelectRow } from '@paperback/types'

import {
  NINEMANGA_LANGUAGE_CONFIGS,
  type NineMangaLanguageId,
} from './NineMangaLanguageConfig'

export const NINEMANGA_LANGUAGE_STATE_KEY = 'ninemanga_language'

export function readNineMangaLanguageSetting(): NineMangaLanguageId {
  const stored = Application.getState(NINEMANGA_LANGUAGE_STATE_KEY)

  const value = Array.isArray(stored)
    ? stored[0]
    : typeof stored === 'string'
      ? stored
      : undefined

  return isNineMangaLanguageId(value) ? value : 'en'
}

function isNineMangaLanguageId(value: unknown): value is NineMangaLanguageId {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(NINEMANGA_LANGUAGE_CONFIGS, value)
  )
}

function selectedLanguageLabel(): string {
  return NINEMANGA_LANGUAGE_CONFIGS[readNineMangaLanguageSetting()].label
}

function selectedReaderMode(): string {
  const flowType = NINEMANGA_LANGUAGE_CONFIGS[readNineMangaLanguageSetting()].flowType
  return flowType === 'english-finance-gate' ? 'Finance reader flow' : 'Localized reader flow'
}

export class NineMangaSettingsForm extends Form {
  private readonly languageOptions = Object.values(NINEMANGA_LANGUAGE_CONFIGS).map((cfg) => ({
    id: cfg.id,
    title: cfg.label,
  }))

  override getSections() {
    return [
      Section(
        {
          id: 'ninemanga_settings',
          header: 'NineManga',
          footer:
            'This setting affects search, discover and chapter loading. English, Español and Русский use the Finance reader flow; other regions use the localized reader.',
        },
        [
          LabelRow('ninemanga_selected_language', {
            title: 'Selected region',
            value: selectedLanguageLabel(),
          }),
          LabelRow('ninemanga_reader_mode', {
            title: 'Reader mode',
            value: selectedReaderMode(),
          }),
          SelectRow(NINEMANGA_LANGUAGE_STATE_KEY, {
            title: '🌍 Language / Region',
            subtitle: 'Choose the catalog region used by NineManga.',
            value: [readNineMangaLanguageSetting()],
            layout: 'list',
            items: this.languageOptions,
            minItemCount: 1,
            maxItemCount: 1,
            onValueChange: Application.Selector(
              this as NineMangaSettingsForm,
              'handleLanguageChange'
            ),
          }),
        ]
      ),
    ]
  }

  async handleLanguageChange(value: string[]): Promise<void> {
    const nextLanguage = value[0]

    if (!isNineMangaLanguageId(nextLanguage)) {
      Application.setState(['en'], NINEMANGA_LANGUAGE_STATE_KEY)
    } else {
      Application.setState([nextLanguage], NINEMANGA_LANGUAGE_STATE_KEY)
    }

    this.reloadForm()
    Application.invalidateDiscoverSections()
  }
}
