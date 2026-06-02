import { ContentRating, SourceIntents, type ExtensionInfo } from '@paperback/types'

const sourceInfo = {
  version: '1.0.1',
  name: 'ReadAllComics',
  icon: 'icon.png',
  description:
    'English comics source focused on ReadAllComics series, issues and reader support.',
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
      label: 'Western Comics',
      textColor: '#ffffff',
      backgroundColor: '#334155',
    },
  ],
  capabilities: [
    SourceIntents.CHAPTER_PROVIDING,
    SourceIntents.SEARCH_RESULT_PROVIDING,
    SourceIntents.DISCOVER_SECTION_PROVIDING,
  ],
} satisfies ExtensionInfo

export default sourceInfo
