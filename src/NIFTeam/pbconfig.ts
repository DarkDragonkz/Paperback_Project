import { ContentRating, SourceIntents, type ExtensionInfo } from '@paperback/types'

const sourceInfo = {
  version: '1.0.0',
  name: 'NIFTeam',
  icon: 'icon.png',
  description: 'Italian scanlation source with catalog, search and reader support.',
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
      label: 'Scanlation',
      textColor: '#ffffff',
      backgroundColor: '#16a34a',
    },
  ],
  capabilities: [
    SourceIntents.CHAPTER_PROVIDING,
    SourceIntents.SEARCH_RESULT_PROVIDING,
    SourceIntents.DISCOVER_SECTION_PROVIDING,
  ],
} satisfies ExtensionInfo

export default sourceInfo
