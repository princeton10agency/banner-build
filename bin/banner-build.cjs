#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const BIN_DIR = __dirname
const PROJECT_BUILD = path.join(BIN_DIR, 'project-build.cjs')

function parseArgs(argv) {
  const flags = {
    lintAssets: false,
    watch: false
  }
  const positional = []

  for (const arg of argv) {
    if (arg === '--lint-assets') {
      flags.lintAssets = true
      continue
    }
    if (arg === '--watch') {
      flags.watch = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      flags.help = true
      continue
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`)
    }
    positional.push(arg)
  }

  return { flags, positional }
}

function hasProjectConfig(dirPath) {
  return fs.existsSync(path.join(dirPath, 'creative.config.json'))
}

function listWorkspaceProjects(baseDir) {
  return fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => path.join(baseDir, entry.name))
    .filter((dirPath) => hasProjectConfig(dirPath))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
}

function runProject(dirPath, extraArgs) {
  execFileSync(process.execPath, [PROJECT_BUILD, ...extraArgs], {
    cwd: dirPath,
    stdio: 'inherit'
  })
}

function printHelp() {
  console.log([
    'usage: banner-build [path] [--lint-assets] [--watch]',
    '',
    'If path contains creative.config.json, the command builds that banner project.',
    'Otherwise it builds each immediate subdirectory that contains creative.config.json.'
  ].join('\n'))
}

function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2))

  if (flags.help) {
    printHelp()
    return
  }

  const targetPath = path.resolve(process.cwd(), positional[0] || '.')
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Target path does not exist: ${targetPath}`)
  }
  if (!fs.statSync(targetPath).isDirectory()) {
    throw new Error(`Target path is not a directory: ${targetPath}`)
  }

  const projects = hasProjectConfig(targetPath)
    ? [targetPath]
    : listWorkspaceProjects(targetPath)

  if (projects.length === 0) {
    throw new Error(`No banner projects found under: ${targetPath}`)
  }

  if (flags.watch && projects.length > 1) {
    throw new Error('watch mode requires a single banner project directory')
  }

  const extraArgs = []
  if (flags.lintAssets) {
    extraArgs.push('--lint-assets')
  }
  if (flags.watch) {
    extraArgs.push('--watch')
  }

  for (const projectPath of projects) {
    runProject(projectPath, extraArgs)
  }
}

try {
  main()
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error))
  process.exitCode = 1
}
