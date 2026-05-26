import { ContentRating, SourceIntents, type ExtensionInfo } from '@paperback/types'

// alpha.57 exposes these capability names with plural/typo spellings.
// Keep the public intent readable here while still using the installed enum values.
const SEARCH_RESULT_PROVIDING = SourceIntents.SEARCH_RESULTS_PROVIDING
const DISCOVER_SECTION_PROVIDING = SourceIntents.DISCOVER_SECIONS_PROVIDING

const sourceInfo = {
  version: '1.0.3',
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
    SEARCH_RESULT_PROVIDING,
    DISCOVER_SECTION_PROVIDING,
    SourceIntents.CLOUDFLARE_BYPASS_PROVIDING,
  ],
} satisfies ExtensionInfo

export default sourceInfo
