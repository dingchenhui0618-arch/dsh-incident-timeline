#!/usr/bin/env node
// Dependency-free build.
//
// Host half: plain ESM with only node: builtins and sibling imports. Copying
// src/ into lib/ is a complete build, so users install prebuilt files and no
// install script has to run on their machine.
//
// Client half: CommonJS loaded through window.__ModuleLoader__, so it must not
// require a relative module at runtime. The single relative require (the
// stylesheet) is inlined here; the build fails loudly if it disappears.
//
// The demo preview imports the same stylesheet, so client-css.cjs is copied to
// lib/ as well.

import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { wrapClient } from './wrap-client.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'lib')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

const hostModules = [
  'decode.js',
  'scan.js',
  'project.js',
  'timeline.js',
  'markdown.js',
  'preview.js',
  'client-css.cjs',
]

await copyFile(join(root, 'src', 'host.js'), join(out, 'index.js'))
for (const file of hostModules) {
  await copyFile(join(root, 'src', file), join(out, file))
}

const cssModule = await import(pathToFileURL(join(root, 'src', 'client-css.cjs')).href)
const css = cssModule.default
if (typeof css !== 'string' || css.length === 0) {
  throw new Error('src/client-css.cjs did not export a non-empty CSS string')
}

const clientSource = await readFile(join(root, 'src', 'client.cjs'), 'utf8')
const CSS_REQUIRE = /require\((['"])\.\/client-css\.cjs\1\)/
if (!CSS_REQUIRE.test(clientSource)) {
  throw new Error('src/client.cjs no longer requires ./client-css.cjs — update scripts/build.mjs')
}

const bundle = wrapClient(clientSource.replace(CSS_REQUIRE, JSON.stringify(css)), pkg.name)
await writeFile(join(out, 'client.js'), bundle)

// A broken build must fail here instead of in the browser, where the error is
// much harder to read.
new Function(bundle)
const host = await import(pathToFileURL(join(out, 'index.js')).href)
if (host.name !== pkg.name || typeof host.apply !== 'function') {
  throw new Error('invalid host plugin export: expected name "' + pkg.name + '" and an apply() function')
}

console.log('Built ' + pkg.name + ' ' + pkg.version + ': lib/index.js and lib/client.js')
