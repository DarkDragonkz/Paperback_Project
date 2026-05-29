import { createFoolSlideExtension } from '../common/foolslide/FoolSlideExtension'

const SOURCE_VERSION = '1.0.0'

export const NIFTeam = createFoolSlideExtension(
  {
    sourceKey: 'NIFTeam',
    sourceName: 'NIFTeam',
    baseUrl: 'https://read-nifteam.info',
    urlModifier: '/slide',
    language: 'it',
  },
  SOURCE_VERSION
)
