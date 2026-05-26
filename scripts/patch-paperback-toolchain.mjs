import fs from 'node:fs'
import path from 'node:path'

const bundlePath = path.join(
  process.cwd(),
  'node_modules',
  '@paperback',
  'toolchain',
  'lib',
  'commands',
  'bundle.js'
)

if (!fs.existsSync(bundlePath)) {
  process.exit(0)
}

let source = fs.readFileSync(bundlePath, 'utf8')

if (!source.includes("import { pathToFileURL } from 'url';")) {
  source = source.replace(
    "import path from 'path';",
    "import path from 'path';\nimport { pathToFileURL } from 'url';"
  )
}

source = source
  .replace(
    "await import(path.join(basePath, 'node_modules/@paperback/types/package.json'), { with: { type: 'json' } })",
    "await import(pathToFileURL(path.join(basePath, 'node_modules/@paperback/types/package.json')).href, { with: { type: 'json' } })"
  )
  .replace(
    "await import(path.join(basePath, 'package.json'), {",
    "await import(pathToFileURL(path.join(basePath, 'package.json')).href, {"
  )
  .replace(
    "await import(`file://${infoJsonPath}`, {",
    "await import(pathToFileURL(infoJsonPath).href, {"
  )

fs.writeFileSync(bundlePath, source)
