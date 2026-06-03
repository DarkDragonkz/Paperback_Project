import { ContentRating, SourceIntents, type ExtensionInfo } from '@paperback/types'

const sourceInfo = {
  version: '1.0.1',
  name: 'GTO The Great Site',
  icon: 'icon.png',
  description: 'Italian manga source with catalog, search and reader support.',
  contentRating: ContentRating.MATURE,
  developers: [
    {
      name: 'DarkDragonkz',
      github: 'DarkDragonkz',
    },
  ],
  language: 'it',
  badges: [
    {
      label: 'Italian',
      textColor: '#ffffff',
      backgroundColor: '#2563eb',
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
  ],
} satisfies ExtensionInfo

export default sourceInfo
