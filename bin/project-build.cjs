#!/usr/bin/env node
const { main } = require('../lib/project-build.cjs')

main(process.argv.slice(2)).catch((error) => {
  console.error(error && error.stack ? error.stack : String(error))
  process.exitCode = 1
})
