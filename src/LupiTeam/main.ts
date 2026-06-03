import { createPizzaReaderExtension } from '../common/pizzareader/PizzaReaderExtension'

const SOURCE_VERSION = '1.0.1'

export const LupiTeam = createPizzaReaderExtension(
  {
    sourceName: 'LupiTeam',
    baseUrl: 'https://lupiteam.net',
    language: 'it',
  },
  SOURCE_VERSION
)
