import { ContentRating, SourceIntents, type ExtensionInfo } from '@paperback/types'

const sourceInfo = {
  version: '1.0.0',
  name: 'AnimeGDRClub',
  icon: 'icon.png',
  description:
    'Italian AnimeGDRClub source with catalogue, search, chapters and reader support.',
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
      label: 'AGC',
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
