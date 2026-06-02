import fs from 'node:fs'
import path from 'node:path'

const bundlePath = path.resolve(
  'node_modules',
  '@paperback',
  'toolchain',
  'dist',
  'src',
  'toolchain',
  'bundle',
  'bundle.mjs'
)
const homepageTemplatePath = path.resolve(
  'node_modules',
  '@paperback',
  'toolchain',
  'dist',
  'src',
  'toolchain',
  'bundle',
  'pages',
  'homepage.template.html'
)

if (!fs.existsSync(bundlePath)) {
  process.exit(0)
}

let source = fs.readFileSync(bundlePath, 'utf8')

if (!source.includes('pathToFileURL')) {
  source = source.replace(
    'import path from "node:path";',
    'import path from "node:path";\nimport { pathToFileURL } from "node:url";'
  )
}

source = source
  .replace(
    /import\(path\.join\(basePath, "node_modules\/@paperback\/types\/package\.json"\), \{ with: \{ type: "json" \} \}\)/g,
    'import(pathToFileURL(path.join(basePath, "node_modules/@paperback/types/package.json")).href, { with: { type: "json" } })'
  )
  .replace(
    /import\(path\.join\(basePath, "package\.json"\), \{ with: \{ type: "json" \} \}\)/g,
    'import(pathToFileURL(path.join(basePath, "package.json")).href, { with: { type: "json" } })'
  )
  .replace(
    /import\(path\.join\(basePath, "deno\.json"\), \{ with: \{ type: "json" \} \}\)/g,
    'import(pathToFileURL(path.join(basePath, "deno.json")).href, { with: { type: "json" } })'
  )
  .replace(
    /import\(`file:\/\/\$\{infoJsonPath\}`, \{ with: \{ type: "json" \} \}\)/g,
    'import(pathToFileURL(infoJsonPath).href, { with: { type: "json" } })'
  )

fs.writeFileSync(bundlePath, source)

if (fs.existsSync(homepageTemplatePath)) {
  let homepage = fs.readFileSync(homepageTemplatePath, 'utf8')

  homepage = homepage
    .replace(/Search sources\.\.\./g, 'Cerca source...')
    .replace(/Available Sources:/g, 'Source disponibili:')
    .replace(/Click on sources to select them for installation/g, 'Seleziona una o più source da installare')
    .replace(/Seleziona una o piu source da installare/g, 'Seleziona una o più source da installare')
    .replace(/Version:/g, 'Versione:')
    .replace(/• Selected/g, '• Selezionata')
    .replace(/No sources found matching your filters/g, 'Nessuna source corrisponde ai filtri')
    .replace(/Reset Filters/g, 'Reimposta filtri')
    .replace(/Please select at least one source/g, 'Seleziona almeno una source')
    .replace(/>\s*Filter\s*</g, '>Filtri<')

  fs.writeFileSync(homepageTemplatePath, homepage)
}
