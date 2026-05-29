import { createPizzaReaderExtension } from '../common/pizzareader/PizzaReaderExtension'

const SOURCE_VERSION = '1.0.0'

export const HastaTeam = createPizzaReaderExtension(
  {
    sourceName: 'Hasta Team',
    baseUrl: 'https://reader.hastateam.com',
    language: 'it',
    requestDelayMs: 1000,
  },
  SOURCE_VERSION
)
