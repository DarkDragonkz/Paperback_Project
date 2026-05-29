import { createPizzaReaderExtension } from '../common/pizzareader/PizzaReaderExtension'

const SOURCE_VERSION = '1.0.0'

export const GTO = createPizzaReaderExtension(
  {
    sourceName: 'GTO The Great Site',
    baseUrl: 'https://reader.gtothegreatsite.net',
    language: 'it',
  },
  SOURCE_VERSION
)
