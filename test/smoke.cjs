#!/usr/bin/env node
const fs = require('fs')
const os = require('os')
const path = require('path')
const sharp = require('sharp')

const ROOT = path.resolve(__dirname, '..')
const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), 'banner-build-smoke-'))

function write(relativePath, content) {
  const target = path.join(FIXTURE, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

async function createFixture() {
  write('index.ejs', `<!doctype html>
<html><head><script>var clickTag = "https://example.com";</script><link rel="stylesheet" href="<%= size.stylesheet %>"></head>
<body><script src="<%= size.javascript %>"></script></body></html>`)
  write('css/styles-300x250.scss', 'body { margin: 0; }\n')
  write('css/styles-160x600.scss', 'body { margin: 0; }\n')
  write('js/main.js', "console.log('fixture')\n")
  fs.mkdirSync(path.join(FIXTURE, 'images'), { recursive: true })
  await sharp({
    create: { width: 600, height: 500, channels: 3, background: '#ffffff' }
  }).jpeg().toFile(path.join(FIXTURE, 'images', 'static-300x250.jpg'))
  await sharp({
    create: { width: 160, height: 600, channels: 3, background: '#ffffff' }
  }).jpeg().toFile(path.join(FIXTURE, 'images', 'static-160x600.jpg'))
  write('creative.config.json', JSON.stringify({
    campaign_title: 'Output name fixture',
    globals: { vars: { click_tag: 'https://example.com' } },
    sizes: [
      {
        id: '300x250',
        output_name: 'JOB-ALPHA-300x250',
        width: 300,
        height: 250,
        stylesheet: 'styles-300x250.css',
        javascript: 'main.js',
        static: 'static-300x250.jpg'
      },
      {
        id: '160x600',
        width: 160,
        height: 600,
        stylesheet: 'styles-160x600.css',
        javascript: 'main.js',
        static: 'static-160x600.jpg'
      }
    ]
  }, null, 2))
}

async function assertBuildOutput() {
  const overrideDir = path.join(FIXTURE, 'dist', 'JOB-ALPHA-300x250')
  const defaultName = `${path.basename(FIXTURE)}-160x600`
  const expected = [
    path.join(overrideDir, 'index.html'),
    path.join(FIXTURE, 'dist', 'JOB-ALPHA-300x250.zip'),
    path.join(FIXTURE, 'dist', defaultName, 'index.html'),
    path.join(FIXTURE, 'dist', `${defaultName}.zip`)
  ]
  for (const target of expected) {
    if (!fs.existsSync(target)) throw new Error(`Expected build output not found: ${target}`)
  }

  const metadata = await sharp(path.join(overrideDir, 'static.jpg')).metadata()
  if (metadata.width !== 300 || metadata.height !== 250) {
    throw new Error(`Expected resized static to be 300x250, got ${metadata.width}x${metadata.height}`)
  }
}

async function assertDuplicateOutputRejected(build) {
  const configPath = path.join(FIXTURE, 'creative.config.json')
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  config.alts = [{ id: 'A' }, { id: 'B' }]
  config.sizes[1].output_name = 'JOB-BETA-160x600'
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
  await build()
  for (const name of ['JOB-ALPHA-300x250-A', 'JOB-ALPHA-300x250-B', 'JOB-BETA-160x600-A', 'JOB-BETA-160x600-B']) {
    if (!fs.existsSync(path.join(FIXTURE, 'dist', name, 'index.html'))) {
      throw new Error(`Expected alt output not found: ${name}`)
    }
  }

  config.sizes[1].output_name = 'JOB-ALPHA-300x250'
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
  await build().then(
    () => { throw new Error('Expected duplicate output_name values to be rejected') },
    (error) => {
      if (!String(error.message).includes('Duplicate output name')) throw error
    }
  )

  config.sizes[1].output_name = 'JOB-BETA-160x600'
  config.sizes[0].output_name = '../unsafe'
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
  await build().then(
    () => { throw new Error('Expected unsafe output_name to be rejected') },
    (error) => {
      if (!String(error.message).includes('invalid "output_name"')) throw error
    }
  )
}

async function main() {
  const previousCwd = process.cwd()

  try {
    await createFixture()
    process.chdir(FIXTURE)
    const { build, lintAssets } = require(path.join(ROOT, 'lib', 'project-build.cjs'))

    await build()
    const ok = lintAssets()
    if (!ok) {
      throw new Error('Expected asset lint to pass for smoke fixture')
    }

    await assertBuildOutput()
    await assertDuplicateOutputRejected(build)
    console.log('Smoke test passed.')
  } finally {
    process.chdir(previousCwd)
    fs.rmSync(FIXTURE, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error))
  process.exitCode = 1
})
