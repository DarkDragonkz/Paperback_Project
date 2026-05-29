import { createPizzaReaderExtension } from '../common/pizzareader/PizzaReaderExtension'

const SOURCE_VERSION = '1.0.0'

export const DDTTeam = createPizzaReaderExtension(
  {
    sourceName: 'DDT Team',
    baseUrl: 'https://ddt.hastateam.com',
    language: 'it',
    requestDelayMs: 1000,
  },
  SOURCE_VERSION
)
