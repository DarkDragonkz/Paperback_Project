import { ContentRating, SourceIntents, type ExtensionInfo } from '@paperback/types'

const sourceInfo = {
  version: '1.0.0',
  name: 'RCOStation',
  icon: 'icon.png',
  description:
    'ReadComicOnline / RCOStation source using normal mobile browser requests for comics, issues, search, and reader pages.',
  contentRating: ContentRating.MATURE,
  developers: [
    {
      name: 'DarkDragonkz',
      github: 'DarkDragonkz',
    },
  ],
  language: 'en',
  badges: [
    {
      label: 'Comics',
      textColor: '#ffffff',
      backgroundColor: '#b91c1c',
    },
  ],
  capabilities: [
    SourceIntents.CHAPTER_PROVIDING,
    SourceIntents.SEARCH_RESULT_PROVIDING,
    SourceIntents.DISCOVER_SECTION_PROVIDING,
  ],
} satisfies ExtensionInfo

export default sourceInfo
