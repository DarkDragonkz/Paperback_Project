import { createPizzaReaderExtension } from '../common/pizzareader/PizzaReaderExtension'

const SOURCE_VERSION = '1.0.0'

export const PhoenixScans = createPizzaReaderExtension(
  {
    sourceName: 'Phoenix Scans',
    baseUrl: 'https://www.phoenixscans.com',
    language: 'it',
  },
  SOURCE_VERSION
)
