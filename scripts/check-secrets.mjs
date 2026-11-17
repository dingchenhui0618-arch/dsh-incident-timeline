#!/usr/bin/env node
// Pre-push secret scan. Dependency-free and intentionally noisy only when a
// real credential shape is found.

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))
const SELF = 'scripts/check-secrets.mjs'
const SKIP_DIRS = new Set(['.git', 'node_modules', 'docs/.demo-data', '.incident-timeline'])
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.bmp',
  '.zstd', '.gz', '.zip', '.7z', '.pdf',
  '.db', '.sqlite', '.sqlite3', '.woff', '.woff2', '.ttf', '.exe', '.dll',
])
const MAX_BYTES = 2 * 1024 * 1024

const PATTERNS = [
  { label: 'GitHub classic token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { label: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { label: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { label: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: 'private key block', re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/g },
  { label: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g },
  { label: 'Bearer token', re: /\bBearer\s+[A-Za-z0-9._-]{24,}\b/g },
  {
    label: 'inline credential assignment',
    re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["'][^"'\r\n]{12,}["']/gi,
  },
]

function listFilesFromGit() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split('\0').filter(Boolean)
  } catch (error) {
    return undefined
  }
}

function walk(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const full = join(dir, entry.name)
    const rel = relative(root, full).split('\\').join('/')
    if (entry.isDirectory()) {
      if (Array.from(SKIP_DIRS).some((skip) => rel === skip || rel.startsWith(skip + '/'))) continue
      files.push(...walk(full))
    } else if (entry.isFile()) {
      files.push(rel)
    }
  }
  return files
}

function isTextFile(file) {
  const lower = file.toLowerCase()
  for (const ext of SKIP_EXT) if (lower.endsWith(ext)) return false
  try {
    if (statSync(join(root, file)).size > MAX_BYTES) return false
    const buffer = readFileSync(join(root, file))
    return !buffer.includes(0)
  } catch (error) {
    return false
  }
}

const files = listFilesFromGit() || walk(root)
const findings = []

for (const file of files) {
  if (file === SELF) continue
  if (!isTextFile(file)) continue
  let text
  try {
    text = readFileSync(join(root, file), 'utf8')
  } catch (error) {
    continue
  }
  const lines = text.split(/\r?\n/)
  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0
    for (let index = 0; index < lines.length; index += 1) {
      pattern.re.lastIndex = 0
      if (pattern.re.test(lines[index])) {
        findings.push({ file: file, line: index + 1, label: pattern.label })
      }
    }
  }
}

if (findings.length > 0) {
  console.error('[FAIL] secret scan found ' + findings.length + ' possible credential(s):')
  for (const finding of findings.slice(0, 50)) {
    console.error('  ' + finding.file + ':' + finding.line + '  ' + finding.label + '  [redacted]')
  }
  if (findings.length > 50) console.error('  … and ' + (findings.length - 50) + ' more')
  process.exit(1)
}

console.log('[PASS] secret scan: ' + files.length + ' files, no credential-shaped strings')
