import { ContentRating, SourceIntents, type ExtensionInfo } from '@paperback/types'

const sourceInfo = {
  version: '1.0.0',
  name: 'JuinJutsuTeamReader',
  icon: 'icon.png',
  description:
    'Italian Juin Jutsu Team Reader source with catalogue, search, chapters and reader support.',
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
      label: 'FoolSlide',
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
