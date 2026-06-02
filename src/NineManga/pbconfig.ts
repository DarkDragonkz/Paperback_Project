import { ContentRating, SourceIntents, type ExtensionInfo } from '@paperback/types'

const sourceInfo = {
  version: '1.0.40',
  name: 'NineManga',
  icon: 'icon.png',
  description:
    'Catalogo NineManga con regioni selezionabili: English, Italiano, Español, Русский e altre.',
  contentRating: ContentRating.ADULT,
  developers: [
    {
      name: 'DarkDragonkz',
      github: 'DarkDragonkz',
    },
  ],
  language: 'en',
  badges: [
    {
      label: 'Multi',
      textColor: '#ffffff',
      backgroundColor: '#2563eb',
    },
  ],
  capabilities: [
    SourceIntents.CHAPTER_PROVIDING,
    SourceIntents.SEARCH_RESULT_PROVIDING,
    SourceIntents.DISCOVER_SECTION_PROVIDING,
    SourceIntents.CLOUDFLARE_BYPASS_PROVIDING,
    SourceIntents.SETTINGS_FORM_PROVIDING,
  ],
} satisfies ExtensionInfo

export default sourceInfo
