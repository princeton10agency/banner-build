#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const ROOT = path.resolve(__dirname, '..')
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'us-xha-0085-resize')
const RESIZED_STATIC = path.join(
  FIXTURE,
  'dist',
  'us-xha-0085-resize-A-300x250-light',
  'static.jpg'
)

async function assertResizedStatic() {
  if (!fs.existsSync(RESIZED_STATIC)) {
    throw new Error(`Expected built static not found: ${RESIZED_STATIC}`)
  }

  const metadata = await sharp(RESIZED_STATIC).metadata()
  if (metadata.width !== 300 || metadata.height !== 250) {
    throw new Error(`Expected resized static to be 300x250, got ${metadata.width}x${metadata.height}`)
  }
}

async function main() {
  const previousCwd = process.cwd()

  if (!fs.existsSync(FIXTURE)) {
    console.log('Smoke fixture not found, skipping local smoke test.')
    return
  }

  try {
    process.chdir(FIXTURE)
    const { build, lintAssets } = require(path.join(ROOT, 'lib', 'project-build.cjs'))

    await build()
    const ok = lintAssets()
    if (!ok) {
      throw new Error('Expected asset lint to pass for smoke fixture')
    }

    await assertResizedStatic()
    console.log('Smoke test passed.')
  } finally {
    process.chdir(previousCwd)
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error))
  process.exitCode = 1
})
