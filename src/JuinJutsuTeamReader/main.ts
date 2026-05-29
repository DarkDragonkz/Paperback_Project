import { createFoolSlideExtension } from '../common/foolslide/FoolSlideExtension'

const SOURCE_VERSION = '1.0.0'

export const JuinJutsuTeamReader = createFoolSlideExtension(
  {
    sourceKey: 'JuinJutsuTeamReader',
    sourceName: 'Juin Jutsu Team Reader',
    baseUrl: 'https://www.juinjutsureader.ovh',
    language: 'it',
    directorySelector: '.series_element',
    chapterListSelector: 'div.group_comic div.element',
  },
  SOURCE_VERSION
)
