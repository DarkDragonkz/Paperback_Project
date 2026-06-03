import { ContentRating, SourceIntents, type ExtensionInfo } from '@paperback/types'

const sourceInfo = {
  version: '1.0.41',
  name: 'NineManga Português',
  icon: 'icon.png',
  description: 'Brazilian Portuguese NineManga source with localized reader support.',
  contentRating: ContentRating.ADULT,
  developers: [
    {
      name: 'DarkDragonkz',
      github: 'DarkDragonkz',
    },
  ],
  language: 'pt-BR',
  badges: [
    {
      label: 'Português',
      textColor: '#ffffff',
      backgroundColor: '#15803d',
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
