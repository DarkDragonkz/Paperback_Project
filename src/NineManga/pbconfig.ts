import { ContentRating, SourceIntents, type ExtensionInfo } from '@paperback/types'

const sourceInfo = {
  version: '1.0.4',
  name: 'NineManga',
  icon: 'icon.png',
  description:
    'NineManga source for a modular Paperback iOS 0.9 extension repository.',
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
      label: 'Source',
      textColor: '#ffffff',
      backgroundColor: '#3b4252',
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
