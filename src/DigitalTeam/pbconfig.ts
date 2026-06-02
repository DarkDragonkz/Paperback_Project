import { ContentRating, SourceIntents, type ExtensionInfo } from '@paperback/types'

const sourceInfo = {
  version: '1.0.0',
  name: 'DigitalTeam',
  icon: 'icon.png',
  description:
    'Italian DigitalTeam scanlation source with catalogue, search, chapters and reader support.',
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
      label: 'DGT',
      textColor: '#ffffff',
      backgroundColor: '#111827',
    },
  ],
  capabilities: [
    SourceIntents.CHAPTER_PROVIDING,
    SourceIntents.SEARCH_RESULT_PROVIDING,
    SourceIntents.DISCOVER_SECTION_PROVIDING,
  ],
} satisfies ExtensionInfo

export default sourceInfo
