import { createPizzaReaderExtension } from '../common/pizzareader/PizzaReaderExtension'

const SOURCE_VERSION = '1.0.0'

export const TuttoAnimeManga = createPizzaReaderExtension(
  {
    sourceName: 'TuttoAnimeManga',
    baseUrl: 'https://tuttoanimemanga.net',
    language: 'it',
  },
  SOURCE_VERSION
)
