import { ContentRating, SourceIntents, type ExtensionInfo } from '@paperback/types'

const sourceInfo = {
  version: '1.0.0',
  name: 'ZeurelScan',
  icon: 'icon.png',
  description:
    'Italian ZeurelScan source with catalogue, search, chapters and reader support.',
  contentRating: ContentRating.EVERYONE,
  developers: [
    {
      name: 'DarkDragonkz',
      github: 'DarkDragonkz',
    },
  ],
  language: 'it',
  badges: [
    {
      label: 'Scan ITA',
      textColor: '#ffffff',
      backgroundColor: '#2563eb',
    },
  ],
  capabilities: [
    SourceIntents.CHAPTER_PROVIDING,
    SourceIntents.SEARCH_RESULT_PROVIDING,
    SourceIntents.DISCOVER_SECTION_PROVIDING,
  ],
} satisfies ExtensionInfo

export default sourceInfo
