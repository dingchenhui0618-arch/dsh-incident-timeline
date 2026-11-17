#!/usr/bin/env node
// Pre-push repository hygiene: .gitignore coverage, tracked junk, untracked
// leftovers, and file-size sanity. Run after `git add -A` but before pushing.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))
const REQUIRED_IGNORES = [
  'node_modules/',
  '.env',
  '.env.*',
  '*.log',
  '*.db',
  '.incident-timeline/',
  'docs/.demo-data/',
]
const FORBIDDEN_DIRS = ['node_modules/', '.git/', 'docs/.demo-data/', '.incident-timeline/', 'tmp/']
const FORBIDDEN_NAMES = new Set([
  '.env', '.npmrc', '.DS_Store', 'Thumbs.db', 'auth.json', '.credentials.yaml',
])
const FORBIDDEN_EXT = ['.zstd', '.jsonl', '.db', '.sqlite', '.sqlite3', '.log', '.pem', '.key', '.p12', '.pfx', '.tmp', '.bak', '.orig']
const MAX_FILE_BYTES = 3 * 1024 * 1024
const SIZE_EXCEPTIONS = new Set(['docs/screenshot-1.png'])
const problems = []

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

function checkIgnoreFile() {
  const path = join(root, '.gitignore')
  if (!existsSync(path)) {
    problems.push('.gitignore is missing')
    return
  }
  const text = readFileSync(path, 'utf8')
  for (const entry of REQUIRED_IGNORES) {
    if (!text.split(/\r?\n/).some((line) => line.trim() === entry)) {
      problems.push('.gitignore does not exclude ' + entry)
    }
  }
}

function checkTracked(files) {
  for (const file of files) {
    const lower = file.toLowerCase()
    if (FORBIDDEN_DIRS.some((dir) => lower === dir.slice(0, -1) || lower.startsWith(dir))) {
      problems.push('tracked forbidden directory: ' + file)
      continue
    }
    const base = lower.split('/').pop()
    if (FORBIDDEN_NAMES.has(base)) problems.push('tracked forbidden file: ' + file)
    if (FORBIDDEN_EXT.some((ext) => lower.endsWith(ext))) problems.push('tracked generated/private file: ' + file)
    if (!SIZE_EXCEPTIONS.has(file.toLowerCase())) {
      try {
        const size = statSync(join(root, file)).size
        if (size > MAX_FILE_BYTES) problems.push('tracked file larger than 3 MB: ' + file + ' (' + size + ' bytes)')
      } catch (error) {
        problems.push('tracked file is missing from the working tree: ' + file)
      }
    }
  }
}

function checkUntracked() {
  const status = git(['status', '--porcelain'])
  for (const line of status.split(/\r?\n/)) {
    if (line.startsWith('??')) problems.push('untracked file left in the working tree: ' + line.slice(3))
  }
}

function checkWorktree() {
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      const rel = relative(root, full).split('\\').join('/')
      if (entry.isDirectory()) {
        if (rel === '.git' || rel === 'node_modules' || rel === 'docs/.demo-data' || rel === '.incident-timeline') continue
        walk(full)
      } else if (entry.isFile()) {
        const lower = rel.toLowerCase()
        if (FORBIDDEN_NAMES.has(lower.split('/').pop())) problems.push('forbidden file in working tree: ' + rel)
        if (FORBIDDEN_EXT.some((ext) => lower.endsWith(ext))) problems.push('generated/private file in working tree: ' + rel)
      }
    }
  }
  walk(root)
}

checkIgnoreFile()
const hasGit = existsSync(join(root, '.git'))
if (hasGit) {
  const files = git(['ls-files', '-z']).split('\0').filter(Boolean)
  checkTracked(files)
  checkUntracked()
  console.log('[INFO] checked ' + files.length + ' tracked files')
} else {
  checkWorktree()
  console.log('[INFO] no .git yet; checked the working tree')
}

if (problems.length > 0) {
  console.error('[FAIL] repository hygiene:')
  for (const problem of problems) console.error('  ' + problem)
  process.exit(1)
}

console.log('[PASS] repository hygiene: .gitignore complete, no tracked junk, no untracked leftovers')
