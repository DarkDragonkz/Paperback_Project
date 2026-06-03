import { ContentRating, SourceIntents, type ExtensionInfo } from '@paperback/types'

const sourceInfo = {
  version: '1.0.41',
  name: 'NineManga Español',
  icon: 'icon.png',
  description: 'Spanish NineManga source with dedicated reader support.',
  contentRating: ContentRating.ADULT,
  developers: [
    {
      name: 'DarkDragonkz',
      github: 'DarkDragonkz',
    },
  ],
  language: 'es',
  badges: [
    {
      label: 'Español',
      textColor: '#ffffff',
      backgroundColor: '#dc2626',
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
