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
