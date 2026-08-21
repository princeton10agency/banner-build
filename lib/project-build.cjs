const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const sharp = require('sharp')

const ROOT = process.cwd()
const DIST_DIR = path.join(ROOT, 'dist')
const CONFIG_PATH = path.join(ROOT, 'creative.config.json')
const INDEX_TEMPLATE = path.join(ROOT, 'index.ejs')
const CSS_SRC_DIR = path.join(ROOT, 'css')
const IMAGE_SRC_DIR = path.join(ROOT, 'images')
const WATCH_EXTENSIONS = new Set(['.js', '.ejs', '.scss', '.json', '.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp'])
const WATCH_IGNORED_DIRS = new Set(['dist', '.git', 'node_modules'])
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif'])
const STATIC_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif'])
const LINT_IGNORED_IMAGE_BASENAMES = new Set(['.DS_Store', 'Thumbs.db'])

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function resolveEjsInclude(baseFile, spec) {
  const withExt = path.extname(spec) ? spec : `${spec}.ejs`
  return path.resolve(path.dirname(baseFile), withExt)
}

function renderEjsFile(filePath, data) {
  const template = readFile(filePath)
  return renderEjsString(template, data, filePath)
}

function renderEjsString(template, data, filePath) {
  const regex = /<%([=-]?)([\s\S]*?)%>/g
  let cursor = 0
  let code = "let __out = '';\n"

  const appendText = (text) => {
    if (!text) return
    code += `__out += ${JSON.stringify(text)};\n`
  }

  let match
  while ((match = regex.exec(template)) !== null) {
    appendText(template.slice(cursor, match.index))
    cursor = match.index + match[0].length

    const sigil = match[1]
    const body = match[2]

    const normalizedBody = body.replace(/;\s*$/, '').trim()

    if (sigil === '=') {
      code += `__out += __escape(((${normalizedBody}) ?? ''));\n`
    } else if (sigil === '-') {
      code += `__out += (((${normalizedBody}) ?? ''));\n`
    } else {
      code += `${body}\n`
    }
  }
  appendText(template.slice(cursor))
  code += 'return __out;\n'

  const include = (spec, locals = {}) => {
    const includePath = resolveEjsInclude(filePath, spec)
    const includeData = { ...data, ...locals }
    return renderEjsFile(includePath, includeData)
  }

  const runtime = { ...data, include }
  const fn = new Function('__data', '__escape', `with (__data) {\n${code}}`)
  return fn(runtime, escapeHtml)
}

function resolveScssImport(fromFile, spec) {
  const fromDir = path.dirname(fromFile)
  const importPath = path.resolve(fromDir, spec)
  const importDir = path.dirname(importPath)
  const importBase = path.basename(importPath)
  const hasExt = path.extname(importPath) !== ''

  const candidates = []
  if (hasExt) {
    candidates.push(importPath)
  } else {
    candidates.push(`${importPath}.scss`)
    candidates.push(path.join(importDir, `_${importBase}.scss`))
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate
    }
  }

  throw new Error(`Unable to resolve SCSS import "${spec}" from ${fromFile}`)
}

function compileScss(entryPath) {
  const seen = new Set()

  const inlineImports = (filePath) => {
    const normalized = path.resolve(filePath)
    if (seen.has(normalized)) {
      return ''
    }
    seen.add(normalized)

    const content = readFile(normalized)
    return content.replace(/^\s*@import\s+['"]([^'"]+)['"]\s*;\s*$/gm, (_line, spec) => {
      const resolved = resolveScssImport(normalized, spec)
      return inlineImports(resolved)
    })
  }

  return inlineImports(entryPath).trim() + '\n'
}

function findMatchingBrace(content, openIndex) {
  let depth = 0

  for (let i = openIndex; i < content.length; i += 1) {
    const char = content[i]
    if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return i
      }
    }
  }

  return -1
}

function pruneCssForAlt(css, altId) {
  if (!altId) {
    return css
  }

  let pruned = css
  const altBlockRegex = /(^|\n)([ \t]*)(?:&\.)?\.?alt-([A-Za-z0-9_-]+)\s*\{/g
  let match

  while ((match = altBlockRegex.exec(pruned)) !== null) {
    const blockAltId = match[3]
    if (blockAltId === altId) {
      continue
    }

    const braceIndex = pruned.indexOf('{', match.index + match[1].length)
    if (braceIndex === -1) {
      continue
    }

    const endIndex = findMatchingBrace(pruned, braceIndex)
    if (endIndex === -1) {
      continue
    }

    pruned = `${pruned.slice(0, match.index)}${pruned.slice(endIndex + 1)}`
    altBlockRegex.lastIndex = match.index
  }

  return pruned
}

function resolveJsImport(fromFile, spec) {
  const fromDir = path.dirname(fromFile)
  const importPath = path.resolve(fromDir, spec)
  const hasExt = path.extname(importPath) !== ''
  const candidates = hasExt ? [importPath] : [`${importPath}.js`, path.join(importPath, 'index.js')]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate
    }
  }

  throw new Error(`Unable to resolve JS import "${spec}" from ${fromFile}`)
}

function compileJs(entryPath) {
  const seen = new Set()
  const sideEffectImportRegex = /^\s*import\s+['"]([^'"]+)['"]\s*;?\s*$/gm
  const namedImportRegex = /^\s*import\s+.+?\s+from\s+['"][^'"]+['"]\s*;?\s*$/m

  const inlineImports = (filePath) => {
    const normalized = path.resolve(filePath)
    if (seen.has(normalized)) {
      return ''
    }
    seen.add(normalized)

    let content = readFile(normalized)
    if (namedImportRegex.test(content)) {
      throw new Error(`Only side-effect imports are supported in this build pipeline: ${normalized}`)
    }

    content = content.replace(sideEffectImportRegex, (_line, spec) => {
      const resolved = resolveJsImport(normalized, spec)
      return inlineImports(resolved)
    })

    return `${content.trim()}\n`
  }

  return inlineImports(entryPath)
}

function resolveScssEntry(stylesheet) {
  const sourceName = path.basename(stylesheet).replace(/\.css$/i, '.scss')
  const candidates = [
    path.join(ROOT, sourceName),
    path.join(CSS_SRC_DIR, sourceName)
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate
    }
  }

  throw new Error(`Missing SCSS entry for stylesheet "${stylesheet}"`)
}

function resolveJsEntry(scriptFile) {
  const sourceName = path.basename(scriptFile)
  const withExt = path.extname(sourceName) ? sourceName : `${sourceName}.js`
  const candidates = [
    path.join(ROOT, withExt),
    path.join(ROOT, 'js', withExt)
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate
    }
  }

  throw new Error(`Missing JS entry for script "${scriptFile}"`)
}

function listFilesRecursive(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return []
  }

  const files = []
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(entryPath))
    } else {
      files.push(entryPath)
    }
  }
  return files
}

function parseSizeFromId(id) {
  const match = String(id || '').match(/(\d+)\s*x\s*(\d+)/i)
  if (!match) {
    return null
  }

  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null
  }

  return { width, height }
}

function resolveExpectedDimensions(sizeConfig) {
  const width = Number(sizeConfig && sizeConfig.width)
  const height = Number(sizeConfig && sizeConfig.height)

  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    return { width, height }
  }

  return parseSizeFromId(sizeConfig && sizeConfig.id)
}

function getUniformDimensionScale(expected, actual) {
  if (!expected || !actual) {
    return null
  }

  const widthScale = actual.width / expected.width
  const heightScale = actual.height / expected.height

  if (!Number.isFinite(widthScale) || !Number.isFinite(heightScale)) {
    return null
  }

  if (widthScale < 1 || heightScale < 1 || widthScale !== heightScale) {
    return null
  }

  return Number.isInteger(widthScale) ? widthScale : null
}

async function writeStaticAssetToTarget(source, destination, sizeConfig) {
  const expected = resolveExpectedDimensions(sizeConfig)
  if (!expected) {
    fs.copyFileSync(source, destination)
    return
  }

  const actual = readImageDimensions(source)
  const scale = getUniformDimensionScale(expected, actual)

  if (!scale) {
    throw new Error(`Static image dimensions must match ${expected.width}x${expected.height} or a uniform integer multiple; got ${actual.width}x${actual.height} for ${source}`)
  }

  if (scale === 1) {
    fs.copyFileSync(source, destination)
    return
  }

  await sharp(source)
    .resize(expected.width, expected.height, { fit: 'fill' })
    .toFile(destination)
}

function readJpegDimensions(buffer, filePath) {
  if (buffer.length < 4 || buffer[0] !== 0xFF || buffer[1] !== 0xD8) {
    throw new Error(`Invalid JPEG header in ${filePath}`)
  }

  let offset = 2
  while (offset + 1 < buffer.length) {
    if (buffer[offset] !== 0xFF) {
      offset += 1
      continue
    }

    while (offset < buffer.length && buffer[offset] === 0xFF) {
      offset += 1
    }
    if (offset >= buffer.length) {
      break
    }

    const marker = buffer[offset]
    offset += 1

    if (marker === 0xD8 || marker === 0xD9) {
      continue
    }

    if (offset + 2 > buffer.length) {
      break
    }

    const segmentLength = buffer.readUInt16BE(offset)
    offset += 2
    if (segmentLength < 2 || offset + segmentLength - 2 > buffer.length) {
      break
    }

    const isSof = (
      (marker >= 0xC0 && marker <= 0xC3) ||
      (marker >= 0xC5 && marker <= 0xC7) ||
      (marker >= 0xC9 && marker <= 0xCB) ||
      (marker >= 0xCD && marker <= 0xCF)
    )

    if (isSof) {
      if (segmentLength < 7) {
        break
      }
      const height = buffer.readUInt16BE(offset + 1)
      const width = buffer.readUInt16BE(offset + 3)
      return { width, height }
    }

    offset += segmentLength - 2
  }

  throw new Error(`Unable to read JPEG dimensions from ${filePath}`)
}

function readWebpDimensions(buffer, filePath) {
  if (
    buffer.length < 16 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    throw new Error(`Invalid WEBP header in ${filePath}`)
  }

  let offset = 12
  while (offset + 8 <= buffer.length) {
    const chunkType = buffer.toString('ascii', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    const dataOffset = offset + 8

    if (chunkType === 'VP8X' && dataOffset + 10 <= buffer.length) {
      const width = 1 + buffer.readUIntLE(dataOffset + 4, 3)
      const height = 1 + buffer.readUIntLE(dataOffset + 7, 3)
      return { width, height }
    }

    if (chunkType === 'VP8 ' && dataOffset + 10 <= buffer.length) {
      if (buffer[dataOffset + 3] === 0x9D && buffer[dataOffset + 4] === 0x01 && buffer[dataOffset + 5] === 0x2A) {
        const width = buffer.readUInt16LE(dataOffset + 6) & 0x3FFF
        const height = buffer.readUInt16LE(dataOffset + 8) & 0x3FFF
        return { width, height }
      }
    }

    if (chunkType === 'VP8L' && dataOffset + 5 <= buffer.length) {
      if (buffer[dataOffset] === 0x2F) {
        const b0 = buffer[dataOffset + 1]
        const b1 = buffer[dataOffset + 2]
        const b2 = buffer[dataOffset + 3]
        const b3 = buffer[dataOffset + 4]
        const width = 1 + (((b1 & 0x3F) << 8) | b0)
        const height = 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6))
        return { width, height }
      }
    }

    offset = dataOffset + chunkSize + (chunkSize % 2)
  }

  throw new Error(`Unable to read WEBP dimensions from ${filePath}`)
}

function readSvgDimensions(filePath) {
  const content = readFile(filePath)

  const widthMatch = content.match(/\bwidth\s*=\s*['"]\s*([0-9]*\.?[0-9]+)\s*(?:px)?\s*['"]/i)
  const heightMatch = content.match(/\bheight\s*=\s*['"]\s*([0-9]*\.?[0-9]+)\s*(?:px)?\s*['"]/i)
  if (widthMatch && heightMatch) {
    const width = Number(widthMatch[1])
    const height = Number(heightMatch[1])
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      return { width, height }
    }
  }

  const viewBoxMatch = content.match(/\bviewBox\s*=\s*['"]\s*[-+]?[0-9]*\.?[0-9]+\s+[-+]?[0-9]*\.?[0-9]+\s+([0-9]*\.?[0-9]+)\s+([0-9]*\.?[0-9]+)\s*['"]/i)
  if (viewBoxMatch) {
    const width = Number(viewBoxMatch[1])
    const height = Number(viewBoxMatch[2])
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      return { width, height }
    }
  }

  throw new Error(`Unable to read SVG dimensions from ${filePath}`)
}

function readImageDimensions(filePath) {
  const ext = path.extname(filePath).toLowerCase()

  if (ext === '.svg') {
    return readSvgDimensions(filePath)
  }

  const buffer = fs.readFileSync(filePath)
  if (ext === '.png') {
    if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504E47) {
      throw new Error(`Invalid PNG header in ${filePath}`)
    }
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20)
    }
  }

  if (ext === '.gif') {
    if (buffer.length < 10 || (buffer.toString('ascii', 0, 6) !== 'GIF87a' && buffer.toString('ascii', 0, 6) !== 'GIF89a')) {
      throw new Error(`Invalid GIF header in ${filePath}`)
    }
    return {
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8)
    }
  }

  if (ext === '.jpg' || ext === '.jpeg') {
    return readJpegDimensions(buffer, filePath)
  }

  if (ext === '.webp') {
    return readWebpDimensions(buffer, filePath)
  }

  throw new Error(`Unsupported image format for dimension checks: ${ext || filePath}`)
}

function isIgnoredLintImageFile(filePath) {
  const base = path.basename(filePath)
  return LINT_IGNORED_IMAGE_BASENAMES.has(base) || base.startsWith('._')
}

function validateClickTagSetup(html) {
  const hasVarClickTag = /\bvar\s+clickTag\s*=/.test(html)

  if (!hasVarClickTag) {
    return 'Missing required "var clickTag = ..." declaration'
  }

  return null
}

function stripQueryAndHash(spec) {
  return spec.replace(/[?#].*$/, '')
}

function getOutputRef(spec) {
  const trimmed = spec.trim()
  const queryOrHashMatch = trimmed.match(/([?#].*)$/)
  const suffix = queryOrHashMatch ? queryOrHashMatch[1] : ''
  const base = path.basename(stripQueryAndHash(trimmed))
  return `${base}${suffix}`
}

function isLocalImageSpec(spec) {
  if (!spec) return false
  const trimmed = spec.trim()
  if (!trimmed || trimmed.startsWith('#')) return false
  if (/^(data:|https?:\/\/|\/\/|mailto:|tel:|javascript:)/i.test(trimmed)) return false
  const ext = path.extname(stripQueryAndHash(trimmed)).toLowerCase()
  return IMAGE_EXTENSIONS.has(ext)
}

function extractImageSpecsFromHtml(html) {
  const specs = []
  const attrRegex = /\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi
  const srcsetRegex = /\bsrcset\s*=\s*["']([^"']+)["']/gi

  let match
  while ((match = attrRegex.exec(html)) !== null) {
    const spec = match[1].trim()
    if (isLocalImageSpec(spec)) {
      specs.push(spec)
    }
  }

  while ((match = srcsetRegex.exec(html)) !== null) {
    const entries = match[1].split(',')
    for (const entry of entries) {
      const spec = entry.trim().split(/\s+/)[0]
      if (isLocalImageSpec(spec)) {
        specs.push(spec)
      }
    }
  }

  return specs
}

function extractImageSpecsFromCss(css) {
  const specs = []
  const urlRegex = /url\(\s*(['"]?)([^"')]+)\1\s*\)/gi
  let match
  while ((match = urlRegex.exec(css)) !== null) {
    const spec = match[2].trim()
    if (isLocalImageSpec(spec)) {
      specs.push(spec)
    }
  }
  return specs
}

function resolveImageSource(spec, scssEntry) {
  const raw = spec.trim()
  const clean = stripQueryAndHash(raw)
  const cleanWithoutLeading = clean.replace(/^\.?\//, '')
  const cleanWithoutImagesPrefix = cleanWithoutLeading.replace(/^images\//, '')

  const candidates = [
    path.resolve(path.dirname(INDEX_TEMPLATE), clean),
    path.resolve(path.dirname(scssEntry), clean),
    path.resolve(ROOT, clean),
    path.join(IMAGE_SRC_DIR, cleanWithoutLeading),
    path.join(IMAGE_SRC_DIR, cleanWithoutImagesPrefix),
    path.join(IMAGE_SRC_DIR, path.basename(clean))
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate
    }
  }

  throw new Error(`Unable to resolve referenced image "${spec}"`)
}

function rewriteImageReferences(content, refMap) {
  const entries = Array.from(refMap.entries()).sort((a, b) => b[0].length - a[0].length)
  let rewritten = content
  for (const [from, to] of entries) {
    rewritten = rewritten.split(from).join(to)
  }
  return rewritten
}

function copyReferencedAssets(outDir, html, css, scssEntry) {
  const specs = [...extractImageSpecsFromHtml(html), ...extractImageSpecsFromCss(css)]
  const uniqueSpecs = Array.from(new Set(specs))
  const refMap = new Map()
  const outputNameToSource = new Map()

  for (const spec of uniqueSpecs) {
    const source = resolveImageSource(spec, scssEntry)
    const outputRef = getOutputRef(spec)
    const outputName = stripQueryAndHash(outputRef)

    if (outputNameToSource.has(outputName)) {
      const previous = outputNameToSource.get(outputName)
      if (path.resolve(previous) !== path.resolve(source)) {
        throw new Error(`Image name collision for "${outputName}" between ${previous} and ${source}`)
      }
    } else {
      outputNameToSource.set(outputName, source)
      fs.copyFileSync(source, path.join(outDir, outputName))
    }

    if (spec !== outputRef) {
      refMap.set(spec, outputRef)
    }
  }

  return {
    html: rewriteImageReferences(html, refMap),
    css: rewriteImageReferences(css, refMap)
  }
}

function collectReferencedAssets(html, css, scssEntry) {
  const specs = [...extractImageSpecsFromHtml(html), ...extractImageSpecsFromCss(css)]
  const uniqueSpecs = Array.from(new Set(specs))
  const refMap = new Map()
  const outputNameToSource = new Map()
  const missingSpecs = []
  const collisions = []

  for (const spec of uniqueSpecs) {
    let source
    try {
      source = resolveImageSource(spec, scssEntry)
    } catch (_error) {
      missingSpecs.push(spec)
      continue
    }

    const outputRef = getOutputRef(spec)
    const outputName = stripQueryAndHash(outputRef)

    if (outputNameToSource.has(outputName)) {
      const previous = outputNameToSource.get(outputName)
      if (path.resolve(previous) !== path.resolve(source)) {
        collisions.push({
          outputName,
          first: previous,
          second: source
        })
      }
    } else {
      outputNameToSource.set(outputName, source)
    }

    if (spec !== outputRef) {
      refMap.set(spec, outputRef)
    }
  }

  return { refMap, outputNameToSource, missingSpecs, collisions }
}

function resolveStaticSource(spec, ownerLabel) {
  const staticSpec = String(spec || '').trim()
  if (!staticSpec) {
    throw new Error(`${ownerLabel} has an empty "static" source`)
  }

  const candidates = [
    path.join(ROOT, staticSpec),
    path.join(IMAGE_SRC_DIR, staticSpec)
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const ext = path.extname(candidate).toLowerCase()
      if (!STATIC_IMAGE_EXTENSIONS.has(ext)) {
        throw new Error(`Static source "${staticSpec}" for ${ownerLabel} must be a PNG, JPG, or GIF`)
      }
      return candidate
    }
  }

  throw new Error(`Unable to resolve static source "${staticSpec}" for ${ownerLabel}`)
}

function isImageOnlySize(size) {
  return !!(size && typeof size === 'object' && size.image === true)
}

function getDynamicSizes(config) {
  const sizes = Array.isArray(config && config.sizes) ? config.sizes : []
  return sizes.filter((size) => !isImageOnlySize(size))
}

function getImageOnlyStaticSizes(config) {
  const sizes = Array.isArray(config && config.sizes) ? config.sizes : []
  return sizes.filter((size) => isImageOnlySize(size))
}

function resolveVariantStatic(config, variant) {
  const globalConfig = (config && config.globals) || {}
  const globalVars = (globalConfig && globalConfig.vars) || {}
  const hasOwn = Object.prototype.hasOwnProperty
  const sizes = getDynamicSizes(config)

  if (variant.alt && hasOwn.call(variant.alt, 'static')) {
    if (sizes.length !== 1) {
      const altId = variant.alt.id || 'unknown'
      throw new Error(`Alt "${altId}" defines "static" but alt-level statics are only supported when exactly one size is configured`)
    }
    return {
      spec: variant.alt.static,
      ownerLabel: `alt "${variant.alt.id || 'unknown'}"`
    }
  }

  if (variant.size && hasOwn.call(variant.size, 'static')) {
    return {
      spec: variant.size.static,
      ownerLabel: `size "${variant.size.id || 'unknown'}"`
    }
  }

  if (hasOwn.call(globalVars, 'static')) {
    return {
      spec: globalVars.static,
      ownerLabel: 'globals.vars'
    }
  }

  if (hasOwn.call(globalConfig, 'static')) {
    return {
      spec: globalConfig.static,
      ownerLabel: 'globals'
    }
  }

  throw new Error('Missing required "static" source. Define it in alt (single-size only), size, globals.vars, or globals')
}

function resolveVariantStaticSource(config, variant) {
  const staticConfig = resolveVariantStatic(config, variant)
  return resolveStaticSource(staticConfig.spec, staticConfig.ownerLabel)
}

function resolveStaticOutputName(config) {
  const globalConfig = (config && config.globals) || {}
  const configuredName = typeof globalConfig.static_name === 'string'
    ? path.basename(globalConfig.static_name.trim())
    : ''

  return configuredName || 'static.jpg'
}

function resolveVariantStaticJobCode(config, variant) {
  const globalConfig = (config && config.globals) || {}
  const globalVars = (globalConfig && globalConfig.vars) || {}
  const hasOwn = Object.prototype.hasOwnProperty

  if (variant.alt && hasOwn.call(variant.alt, 'static_job_code')) {
    return String(variant.alt.static_job_code || '').trim()
  }

  if (variant.size && hasOwn.call(variant.size, 'static_job_code')) {
    return String(variant.size.static_job_code || '').trim()
  }

  if (hasOwn.call(globalVars, 'static_job_code')) {
    return String(globalVars.static_job_code || '').trim()
  }

  if (hasOwn.call(globalConfig, 'static_job_code')) {
    return String(globalConfig.static_job_code || '').trim()
  }

  return ''
}

function buildStaticOutputPrefix(projectName, outDirName, staticJobCode) {
  const override = String(staticJobCode || '').trim()
  if (!override) {
    return outDirName
  }

  if (outDirName === projectName) {
    return override
  }

  const prefix = `${projectName}-`
  if (outDirName.startsWith(prefix)) {
    return `${override}-${outDirName.slice(prefix.length)}`
  }

  return `${override}-${outDirName}`
}

async function copyVariantStaticAsset(config, outDir, variant) {
  const staticSource = resolveVariantStaticSource(config, variant)
  await writeStaticAssetToTarget(staticSource, path.join(outDir, resolveStaticOutputName(config)), variant.size)
}

function getTimelineFrameNumbers(scriptFile) {
  const jsEntry = resolveJsEntry(scriptFile)
  const content = fs.readFileSync(jsEntry, 'utf8')
  const frameNumbers = new Set()
  const regex = /addLabel\(\s*['"]frame(\d+)['"]/g
  let match

  while ((match = regex.exec(content)) !== null) {
    frameNumbers.add(Number(match[1]))
  }

  return Array.from(frameNumbers)
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
}

function getBuildVariants(config) {
  const globalConfig = (config && config.globals) || {}
  const globals = {
    ...globalConfig,
    ...((globalConfig && globalConfig.vars) || {})
  }
  delete globals.vars
  const sizes = getDynamicSizes(config)
  const alts = Array.isArray(config.alts) && config.alts.length > 0 ? config.alts : [null]
  const projectName = path.basename(ROOT)
  const variants = []
  const outputNames = new Map()
  const hasAltLevelStatic = alts.some((alt) => alt && typeof alt === 'object' && Object.prototype.hasOwnProperty.call(alt, 'static'))

  if (hasAltLevelStatic && sizes.length !== 1) {
    throw new Error('Alt-level "static" is only supported when exactly one size is configured')
  }

  for (const alt of alts) {
    const hasAlt = !!(alt && typeof alt === 'object')
    const altId = hasAlt ? alt.id : null
    if (hasAlt && !altId) {
      throw new Error('Each alt must include a non-empty "id"')
    }

    for (const size of sizes) {
      const sizeId = size.id
      const width = size.width
      const height = size.height
      const stylesheet = path.basename(size.stylesheet || `styles-${sizeId}.css`)
      const scriptFile = path.basename(size.javascript || 'main.js')
      const configuredOutputName = Object.prototype.hasOwnProperty.call(size, 'output_name')
        ? String(size.output_name || '').trim()
        : ''
      if (Object.prototype.hasOwnProperty.call(size, 'output_name') && !configuredOutputName) {
        throw new Error(`Size "${sizeId || 'unknown'}" defines an empty "output_name"`)
      }
      if (configuredOutputName && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(configuredOutputName)) {
        throw new Error(`Size "${sizeId || 'unknown'}" has invalid "output_name" "${configuredOutputName}"; use only letters, numbers, dots, underscores, and hyphens`)
      }
      const outputBase = configuredOutputName || projectName
      const outDirName = configuredOutputName
        ? (hasAlt ? `${outputBase}-${altId}` : outputBase)
        : (hasAlt ? `${projectName}-${altId}-${sizeId}` : `${projectName}-${sizeId}`)
      const variantLabel = hasAlt ? `alt "${altId}", size "${sizeId}"` : `size "${sizeId}"`
      if (outputNames.has(outDirName)) {
        throw new Error(`Duplicate output name "${outDirName}" for ${outputNames.get(outDirName)} and ${variantLabel}`)
      }
      outputNames.set(outDirName, variantLabel)
      const outDir = path.join(DIST_DIR, outDirName)
      const altVars = hasAlt ? { ...alt } : {}
      const vars = {
        ...globals,
        ...altVars,
        alt_id: altId || '',
        body_class: altId ? `alt-${altId}` : '',
        banner_width: `${width}px`,
        banner_height: `${height}px`
      }

      variants.push({
        size,
        alt: hasAlt ? alt : null,
        stylesheet,
        scriptFile,
        outDirName,
        outDir,
        vars,
        sizeView: { ...size, width, height, stylesheet, javascript: scriptFile }
      })
    }
  }

  return variants
}

function buildDistIndex(variants, staticsZipName) {
  const previewPadding = 4
  const groups = []
  const groupByKey = new Map()

  for (const variant of variants) {
    const altId = variant.alt && typeof variant.alt.id === 'string' && variant.alt.id.length > 0
      ? variant.alt.id
      : 'default'
    const label = variant.alt && variant.alt.id ? `Alt: ${variant.alt.id}` : 'Default'

    if (!groupByKey.has(altId)) {
      const group = { key: altId, label, variants: [] }
      groupByKey.set(altId, group)
      groups.push(group)
    }

    groupByKey.get(altId).variants.push(variant)
  }

  const rows = groups
    .map((group) => {
      const cards = group.variants.map((variant) => {
        const href = `${variant.outDirName}/index.html`
        const zipHref = `${variant.outDirName}.zip`
        const frameLinks = getTimelineFrameNumbers(variant.scriptFile)
          .map((frameNumber) => `<a class="frame-btn" href="${href}?frame=${frameNumber}" target="_blank" rel="noopener noreferrer">F${frameNumber}</a>`)
          .join('')
        const frameWidth = Number(variant.size.width) || 300
        const frameHeight = Number(variant.size.height) || 250
        const previewWidth = frameWidth + previewPadding
        const previewHeight = frameHeight + previewPadding
        return `<section class="card">
  <a class="name" href="${href}" target="_blank" rel="noopener noreferrer">${variant.outDirName}</a>
  <div class="card-actions">
    <a class="download-btn" href="${zipHref}" download>Download Zip</a>
    ${frameLinks}
  </div>
  <iframe title="${variant.outDirName}" src="${href}" loading="lazy" width="${previewWidth}" height="${previewHeight}"></iframe>
</section>`
      }).join('\n')

      return `<section class="row-group">
  <h2 class="row-title">${group.label}</h2>
  <div class="row">
${cards}
  </div>
</section>`
    })
    .join('\n')

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${path.basename(ROOT)} Dist Preview</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Arial, Helvetica, sans-serif;
        background: #f3f4f6;
        color: #111827;
      }
      header {
        position: sticky;
        top: 0;
        z-index: 10;
        background: #111827;
        color: #fff;
        padding: 12px 16px;
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .download-link {
        color: #93c5fd;
        text-decoration: none;
        font-size: 14px;
      }
      .download-link:hover {
        text-decoration: underline;
      }
      .grid {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 12px;
      }
      .row-group {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .row-title {
        margin: 0;
        font-size: 12px;
        font-weight: 700;
        color: #374151;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-start;
        gap: 12px;
      }
      .card {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        background: #fff;
        border: 1px solid #d1d5db;
        border-radius: 8px;
        padding: 10px;
        width: fit-content;
      }
      .name {
        display: inline-block;
        font-size: 13px;
        margin-bottom: 8px;
        font-weight: 700;
        color: #111827;
        text-decoration: none;
      }
      .name:hover {
        text-decoration: underline;
      }
      .download-btn {
        display: inline-block;
        border: 1px solid #d1d5db;
        border-radius: 6px;
        padding: 4px 8px;
        color: #111827;
        text-decoration: none;
        background: #f9fafb;
        font-size: 12px;
        line-height: 1;
      }
      .download-btn:hover {
        background: #f3f4f6;
      }
      .card-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        margin-bottom: 8px;
      }
      .frame-btn {
        display: inline-block;
        min-width: 28px;
        border: 1px solid #d1d5db;
        border-radius: 6px;
        padding: 4px 6px;
        color: #111827;
        text-decoration: none;
        background: #f9fafb;
        font-size: 11px;
        line-height: 1;
        text-align: center;
      }
      .frame-btn:hover {
        background: #f3f4f6;
      }
      iframe {
        display: block;
        border: 1px solid #e5e7eb;
        background: #fff;
      }
    </style>
  </head>
  <body>
    <header>
      <span>${path.basename(ROOT)}</span>
      ${staticsZipName ? `<a class="download-link" href="${staticsZipName}" download>Download Statics</a>` : ''}
    </header>
    <main class="grid">
${rows}
    </main>
  </body>
</html>
`
}

async function createStaticsZip(config, variants) {
  const staticEntries = []
  const projectName = path.basename(ROOT)

  for (const variant of Array.isArray(variants) ? variants : []) {
    const staticConfig = resolveVariantStatic(config, variant)
    const staticJobCode = resolveVariantStaticJobCode(config, variant)
    staticEntries.push({
      spec: staticConfig.spec,
      ownerLabel: staticConfig.ownerLabel,
      outputPrefix: buildStaticOutputPrefix(
        projectName,
        variant.outDirName,
        staticJobCode
      ),
      forcePrefix: !!staticJobCode,
      sizeConfig: variant.size
    })
  }

  for (const size of getImageOnlyStaticSizes(config)) {
    const staticJobCode = size && Object.prototype.hasOwnProperty.call(size, 'static_job_code')
      ? String(size.static_job_code || '').trim()
      : String((((config || {}).globals || {}).vars || {}).static_job_code || (((config || {}).globals || {}).static_job_code || '')).trim()
    staticEntries.push({
      spec: size && Object.prototype.hasOwnProperty.call(size, 'static') ? size.static : '',
      ownerLabel: `size "${(size && size.id) || 'unknown'}"`,
      outputPrefix: buildStaticOutputPrefix(
        projectName,
        `${projectName}-${(size && size.id) || 'image'}`,
        staticJobCode
      ),
      forcePrefix: !!staticJobCode,
      sizeConfig: size
    })
  }

  if (staticEntries.length === 0) {
    return null
  }

  const zipName = `${projectName}-statics.zip`
  const zipPath = path.join(DIST_DIR, zipName)
  const stageDir = path.join(DIST_DIR, '.statics-tmp')
  const usedNames = new Map()

  fs.rmSync(stageDir, { recursive: true, force: true })
  fs.rmSync(zipPath, { force: true })
  fs.mkdirSync(stageDir, { recursive: true })

  try {
    for (const entry of staticEntries) {
      const src = resolveStaticSource(entry.spec, entry.ownerLabel)
      const requestedName = path.basename(String(entry.spec || '').trim()) || `${entry.outputPrefix}-static.jpg`
      let outputName = entry.forcePrefix ? `${entry.outputPrefix}-${requestedName}` : requestedName
      const sourceKey = `${path.resolve(src)}:${sizeConfigKey(entry.sizeConfig)}`

      if (usedNames.has(outputName) && usedNames.get(outputName) !== sourceKey) {
        outputName = `${entry.outputPrefix}-${requestedName}`
      }
      if (usedNames.has(outputName) && usedNames.get(outputName) === sourceKey) {
        continue
      }
      usedNames.set(outputName, sourceKey)
      await writeStaticAssetToTarget(src, path.join(stageDir, outputName), entry.sizeConfig)
    }

    execFileSync('zip', ['-q', '-r', zipPath, '.'], { cwd: stageDir })
    return zipName
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true })
  }
}

function createVariantZip(variant) {
  const zipName = `${variant.outDirName}.zip`
  const zipPath = path.join(DIST_DIR, zipName)
  fs.rmSync(zipPath, { force: true })
  execFileSync('zip', ['-q', '-r', zipPath, '.'], { cwd: variant.outDir })
}

function sizeConfigKey(sizeConfig) {
  const expected = resolveExpectedDimensions(sizeConfig)
  if (!expected) {
    return 'unknown'
  }
  return `${expected.width}x${expected.height}`
}

async function build() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Missing config: ${CONFIG_PATH}`)
  }
  if (!fs.existsSync(INDEX_TEMPLATE)) {
    throw new Error(`Missing template: ${INDEX_TEMPLATE}`)
  }

  const config = JSON.parse(readFile(CONFIG_PATH))
  const variants = getBuildVariants(config)

  fs.rmSync(DIST_DIR, { recursive: true, force: true })
  fs.mkdirSync(DIST_DIR, { recursive: true })

  for (const variant of variants) {
    fs.mkdirSync(variant.outDir, { recursive: true })

    const html = renderEjsFile(INDEX_TEMPLATE, {
      size: variant.sizeView,
      alt: variant.alt,
      vars: variant.vars,
      title: variant.outDirName
    })

    const scssEntry = resolveScssEntry(variant.stylesheet)
    const css = pruneCssForAlt(compileScss(scssEntry), variant.vars.alt_id)

    const rewrittenAssets = copyReferencedAssets(variant.outDir, html, css, scssEntry)
    writeFile(path.join(variant.outDir, 'index.html'), rewrittenAssets.html)
    writeFile(path.join(variant.outDir, variant.stylesheet), rewrittenAssets.css)

    const jsEntry = resolveJsEntry(variant.scriptFile)
    const js = compileJs(jsEntry)
    writeFile(path.join(variant.outDir, variant.scriptFile), js)

    await copyVariantStaticAsset(config, variant.outDir, variant)
    createVariantZip(variant)

    console.log(`Built ${path.relative(ROOT, variant.outDir)}`)
  }

  const staticsZipName = await createStaticsZip(config, variants)
  writeFile(path.join(DIST_DIR, 'index.html'), buildDistIndex(variants, staticsZipName))
  console.log(`Built ${path.relative(ROOT, path.join(DIST_DIR, 'index.html'))}`)
}

function lintAssets() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Missing config: ${CONFIG_PATH}`)
  }
  if (!fs.existsSync(INDEX_TEMPLATE)) {
    throw new Error(`Missing template: ${INDEX_TEMPLATE}`)
  }

  const config = JSON.parse(readFile(CONFIG_PATH))
  const variants = getBuildVariants(config)
  const usedSources = new Set()
  const missing = []
  const collisions = []
  const staticDimensionIssues = []
  const clickTagIssues = []
  const dimensionCache = new Map()

  const checkStaticDimensions = (label, sizeConfig, staticSource) => {
    const expected = resolveExpectedDimensions(sizeConfig)
    if (!expected) {
      staticDimensionIssues.push({
        label,
        staticSource,
        message: 'No expected size found (set width/height or include WxH in id)'
      })
      return
    }

    const cacheKey = path.resolve(staticSource)
    let actualOrError = dimensionCache.get(cacheKey)
    if (!actualOrError) {
      try {
        actualOrError = { dimensions: readImageDimensions(staticSource) }
      } catch (error) {
        actualOrError = { error: String(error && error.message ? error.message : error) }
      }
      dimensionCache.set(cacheKey, actualOrError)
    }

    if (actualOrError.error) {
      staticDimensionIssues.push({
        label,
        staticSource,
        message: actualOrError.error
      })
      return
    }

    const actual = actualOrError.dimensions
    const scale = getUniformDimensionScale(expected, actual)
    if (!scale) {
      staticDimensionIssues.push({
        label,
        staticSource,
        message: `Expected ${expected.width}x${expected.height}, got ${actual.width}x${actual.height}`
      })
    }
  }

  for (const variant of variants) {
    const html = renderEjsFile(INDEX_TEMPLATE, {
      size: variant.sizeView,
      alt: variant.alt,
      vars: variant.vars,
      title: variant.outDirName
    })
    const clickTagIssue = validateClickTagSetup(html)
    if (clickTagIssue) {
      clickTagIssues.push({ variant: variant.outDirName, message: clickTagIssue })
    }

    const scssEntry = resolveScssEntry(variant.stylesheet)
    const css = pruneCssForAlt(compileScss(scssEntry), variant.vars.alt_id)
    const refs = collectReferencedAssets(html, css, scssEntry)

    for (const src of refs.outputNameToSource.values()) {
      usedSources.add(path.resolve(src))
    }
    for (const spec of refs.missingSpecs) {
      missing.push({ variant: variant.outDirName, spec })
    }
    for (const collision of refs.collisions) {
      collisions.push({ variant: variant.outDirName, ...collision })
    }

    try {
      const staticSource = resolveVariantStaticSource(config, variant)
      usedSources.add(path.resolve(staticSource))
      checkStaticDimensions(variant.outDirName, variant.size, staticSource)
    } catch (error) {
      missing.push({ variant: variant.outDirName, spec: String(error.message || error) })
    }
  }

  for (const size of getImageOnlyStaticSizes(config)) {
    const ownerLabel = `size "${(size && size.id) || 'unknown'}"`
    try {
      const staticSource = resolveStaticSource(size && size.static, ownerLabel)
      usedSources.add(path.resolve(staticSource))
      checkStaticDimensions(ownerLabel, size, staticSource)
    } catch (error) {
      missing.push({ variant: ownerLabel, spec: String(error.message || error) })
    }
  }

  const imageFiles = listFilesRecursive(IMAGE_SRC_DIR)
    .map((p) => path.resolve(p))
    .filter((p) => !isIgnoredLintImageFile(p))
  const unused = imageFiles.filter((p) => !usedSources.has(p))

  console.log('Asset lint report')
  console.log(`- Referenced image files: ${usedSources.size}`)
  console.log(`- Image files in images/: ${imageFiles.length}`)
  console.log(`- Unused image files: ${unused.length}`)

  if (missing.length > 0) {
    console.log('\nMissing image references:')
    for (const item of missing) {
      console.log(`- ${item.variant}: ${item.spec}`)
    }
  }

  if (collisions.length > 0) {
    console.log('\nImage filename collisions after flattening:')
    for (const item of collisions) {
      console.log(`- ${item.variant}: ${item.outputName}`)
      console.log(`  first: ${item.first}`)
      console.log(`  second: ${item.second}`)
    }
  }

  if (unused.length > 0) {
    console.log('\nUnused files in images/:')
    for (const filePath of unused) {
      console.log(`- ${path.relative(ROOT, filePath)}`)
    }
  }

  if (staticDimensionIssues.length > 0) {
    console.log('\nStatic image dimension issues:')
    for (const issue of staticDimensionIssues) {
      console.log(`- ${issue.label}: ${issue.message}`)
      console.log(`  source: ${path.relative(ROOT, issue.staticSource)}`)
    }
  }

  if (clickTagIssues.length > 0) {
    console.log('\nClickTag setup issues:')
    for (const issue of clickTagIssues) {
      console.log(`- ${issue.variant}: ${issue.message}`)
    }
  }

  const failed = missing.length > 0 || collisions.length > 0 || unused.length > 0 || staticDimensionIssues.length > 0 || clickTagIssues.length > 0
  if (!failed) {
    console.log('\nAsset lint passed with no issues.')
  }
  return !failed
}

function listInputFiles(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      if (WATCH_IGNORED_DIRS.has(entry.name)) {
        continue
      }
      files.push(...listInputFiles(entryPath))
      continue
    }

    const ext = path.extname(entry.name).toLowerCase()
    if (WATCH_EXTENSIONS.has(ext)) {
      files.push(entryPath)
    }
  }

  return files
}

function snapshotFiles() {
  const snapshot = new Map()
  const files = listInputFiles(ROOT)

  for (const filePath of files) {
    const stats = fs.statSync(filePath)
    snapshot.set(filePath, `${stats.mtimeMs}:${stats.size}`)
  }

  return snapshot
}

function hasSnapshotChanged(previous, current) {
  if (previous.size !== current.size) {
    return true
  }

  for (const [filePath, signature] of current.entries()) {
    if (previous.get(filePath) !== signature) {
      return true
    }
  }

  return false
}

async function runBuildSafe() {
  try {
    await build()
  } catch (error) {
    const message = error && error.stack ? error.stack : String(error)
    console.error(message)
  }
}

function watch() {
  console.log('Watching for input changes...')
  void runBuildSafe()

  let previousSnapshot = snapshotFiles()
  let buildQueued = false

  const scheduleBuild = () => {
    if (buildQueued) {
      return
    }
    buildQueued = true
    setTimeout(async () => {
      buildQueued = false
      await runBuildSafe()
      previousSnapshot = snapshotFiles()
    }, 100)
  }

  setInterval(() => {
    const nextSnapshot = snapshotFiles()
    if (hasSnapshotChanged(previousSnapshot, nextSnapshot)) {
      previousSnapshot = nextSnapshot
      scheduleBuild()
    }
  }, 500)
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--lint-assets')) {
    const ok = lintAssets()
    if (!ok) {
      process.exitCode = 1
    }
    return
  }

  if (argv.includes('--watch')) {
    watch()
    return
  }

  await build()
}

module.exports = {
  build,
  lintAssets,
  watch,
  main
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error))
    process.exitCode = 1
  })
}
