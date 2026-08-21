#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const sharp = require('sharp')

const ROOT = path.resolve(__dirname, '..')
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'isi-screenshot-fixture')
const DEFAULT_BANNER_SET = FIXTURE

function hasPlaywright() {
  try {
    require.resolve('playwright')
    return true
  } catch (_error) {
    try {
      require.resolve('playwright-core')
      return true
    } catch (_fallbackError) {
      return false
    }
  }
}

async function hasChromium() {
  try {
    const playwright = (() => {
      try {
        return require('playwright')
      } catch (_error) {
        return require('playwright-core')
      }
    })()
    const launchOptions = { headless: true }
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH ||
      process.env.CHROME_PATH ||
      process.env.GOOGLE_CHROME_PATH ||
      process.env.CHROMIUM_PATH ||
      process.env.CHROMIUM_BROWSER_PATH
    if (executablePath) {
      launchOptions.executablePath = executablePath
    }
    const browser = await playwright.chromium.launch(launchOptions)
    await browser.close()
    return true
  } catch (_error) {
    return false
  }
}

function listZipEntries(zipPath) {
  const output = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function extractZipEntry(zipPath, entryName) {
  return execFileSync('unzip', ['-p', zipPath, entryName])
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function resolveBannerSetPath(argv) {
  const candidate = argv[2] ? path.resolve(process.cwd(), argv[2]) : DEFAULT_BANNER_SET
  return candidate
}

async function main() {
  const bannerSetPath = resolveBannerSetPath(process.argv)
  const configPath = path.join(bannerSetPath, 'creative.config.json')

  if (!fs.existsSync(configPath)) {
    console.log(`Skipping ISI screenshots for ${path.basename(bannerSetPath)}: creative.config.json not found.`)
    return
  }

  const config = readJson(configPath)
  const screenshotConfig = config && config.isi_screenshots
  if (!screenshotConfig || screenshotConfig.enabled !== true) {
    console.log(`Skipping ISI screenshots for ${path.basename(bannerSetPath)}: isi_screenshots is missing or disabled.`)
    return
  }

  if (!hasPlaywright()) {
    console.log('Playwright is not installed, skipping screenshot integration test.')
    return
  }

  if (!(await hasChromium())) {
    console.log('Chromium is not available to Playwright, skipping screenshot integration test.')
    return
  }

  const projectName = path.basename(bannerSetPath)
  const distDir = path.join(bannerSetPath, 'dist')
  const variantZip = path.join(distDir, `${projectName}-300x250.zip`)
  const staticsZip = path.join(distDir, `${projectName}-statics.zip`)
  const screenshotZip = path.join(distDir, `${projectName}-isi-screenshots.zip`)
  const screenshotEntry = `${projectName}-300x250.png`
  const previousCwd = process.cwd()

  try {
    process.chdir(bannerSetPath)
    const { build, lintAssets } = require(path.join(ROOT, 'lib', 'project-build.cjs'))

    await build()
    if (fs.existsSync(screenshotZip)) {
      throw new Error('Screenshot zip should not be created unless the feature is enabled')
    }

    await build({ isiScreenshots: true })

    if (!fs.existsSync(screenshotZip)) {
      throw new Error('Expected screenshot zip to be created in screenshot mode')
    }
    if (!fs.existsSync(variantZip)) {
      throw new Error('Expected variant zip to be created')
    }
    if (!fs.existsSync(staticsZip)) {
      throw new Error('Expected statics zip to be created')
    }

    const screenshotEntries = listZipEntries(screenshotZip)
    if (screenshotEntries.length !== 1 || screenshotEntries[0] !== screenshotEntry) {
      throw new Error(`Unexpected screenshot zip contents: ${screenshotEntries.join(', ')}`)
    }

    const variantEntries = listZipEntries(variantZip)
    if (variantEntries.some((entry) => entry.toLowerCase().endsWith('.png'))) {
      throw new Error('Variant zip should not include screenshot PNGs')
    }

    const staticsEntries = listZipEntries(staticsZip)
    if (staticsEntries.some((entry) => entry.toLowerCase().endsWith('.png'))) {
      throw new Error('Statics zip should not include screenshot PNGs')
    }

    const screenshotBuffer = extractZipEntry(screenshotZip, screenshotEntry)
    const metadata = await sharp(screenshotBuffer).metadata()
    if (metadata.width !== 300) {
      throw new Error(`Expected screenshot width to be 300, got ${metadata.width}`)
    }
    if (metadata.height <= 250) {
      throw new Error(`Expected screenshot height to exceed the collapsed viewport, got ${metadata.height}`)
    }

    const { data, info } = await sharp(screenshotBuffer).raw().toBuffer({ resolveWithObject: true })
    const channels = info.channels
    const centerIndex = Math.floor(info.width / 2) * channels
    const bottomIndex = ((info.height - 1) * info.width + Math.floor(info.width / 2)) * channels
    const topPixel = Array.from(data.slice(centerIndex, centerIndex + channels))
    const bottomPixel = Array.from(data.slice(bottomIndex, bottomIndex + channels))

    const isRed = (pixel) => pixel[0] > 180 && pixel[1] < 100 && pixel[2] < 100
    if (isRed(topPixel) || isRed(bottomPixel)) {
      throw new Error('Sticky header or footer colors leaked into the screenshot')
    }

    const lintOk = lintAssets()
    if (!lintOk) {
      throw new Error('Expected asset lint to pass after screenshot build')
    }

    console.log('Screenshot integration test passed.')
  } finally {
    process.chdir(previousCwd)
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error))
  process.exitCode = 1
})
