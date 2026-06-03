import { ContentRating, SourceIntents, type ExtensionInfo } from '@paperback/types'

const sourceInfo = {
  version: '1.0.42',
  name: 'NineManga Русский',
  icon: 'icon.png',
  description: 'Russian NineManga source with dedicated reader support.',
  contentRating: ContentRating.ADULT,
  developers: [
    {
      name: 'DarkDragonkz',
      github: 'DarkDragonkz',
    },
  ],
  language: 'ru',
  badges: [
    {
      label: 'Русский',
      textColor: '#ffffff',
      backgroundColor: '#1d4ed8',
    },
    {
      label: 'Manga',
      textColor: '#ffffff',
      backgroundColor: '#7c3aed',
    },
  ],
  capabilities: [
    SourceIntents.CHAPTER_PROVIDING,
    SourceIntents.SEARCH_RESULT_PROVIDING,
    SourceIntents.DISCOVER_SECTION_PROVIDING,
    SourceIntents.CLOUDFLARE_BYPASS_PROVIDING,
  ],
} satisfies ExtensionInfo

export default sourceInfo
